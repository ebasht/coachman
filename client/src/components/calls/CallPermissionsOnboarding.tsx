import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import {
  getCallPermissionState,
  markCallOnboardingDone,
  markCallOnboardingSkipped,
  openBatterySettings,
  openCallChannelSettings,
  openFullScreenCallSettings,
  openNotificationSettings,
  requestBluetoothPermission,
  requestMediaPermissionsState,
  requestNotificationPermission,
  statusLabel,
  type CallPermissionState,
} from '../../lib/call-permissions';
import { isNativeAndroid } from '../../lib/native-calls';

type Step =
  | 'intro'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | 'bluetooth'
  | 'fullscreen'
  | 'channel'
  | 'battery'
  | 'done';

interface Props {
  onClose: () => void;
  onOpenDiagnostics?: () => void;
}

export function CallPermissionsOnboarding({ onClose, onOpenDiagnostics }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [state, setState] = useState<CallPermissionState | null>(null);
  const [busy, setBusy] = useState(false);
  const requestingRef = useRef(false);

  const refresh = useCallback(async () => {
    const next = await getCallPermissionState();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    let handle: { remove: () => Promise<void> } | undefined;
    if (Capacitor.isNativePlatform()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void refresh();
      }).then((h) => {
        handle = h;
      });
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void handle?.remove();
    };
  }, [refresh]);

  const guard = async (fn: () => Promise<CallPermissionState | void>) => {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setBusy(true);
    try {
      const result = await fn();
      if (result) setState(result);
      else await refresh();
    } finally {
      setBusy(false);
      requestingRef.current = false;
    }
  };

  if (!isNativeAndroid()) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal call-perm-modal" onClick={(e) => e.stopPropagation()}>
          <h2>Настройка звонков</h2>
          <p className="modal-subtitle">Доступна только в Android-приложении.</p>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    );
  }

  const s = state;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal call-perm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Настройка звонков</h2>

        {step === 'intro' && (
          <>
            <p className="modal-subtitle">
              Чтобы входящие звонки открывались поверх блокировки на Samsung, нужны уведомления,
              полноэкранные оповещения и доступ к камере/микрофону.
            </p>
            <ul className="call-perm-list">
              <li>Уведомления — {statusLabel({ granted: !!s?.notificationsGranted && !!s?.appNotificationsEnabled })}</li>
              <li>Камера — {statusLabel({ granted: !!s?.cameraGranted })}</li>
              <li>Микрофон — {statusLabel({ granted: !!s?.microphoneGranted })}</li>
              <li>
                Bluetooth —{' '}
                {statusLabel({
                  granted: !!s?.bluetoothGranted,
                  notRequired: s ? !s.bluetoothRequired : false,
                })}
              </li>
              <li>
                Полноэкранные звонки —{' '}
                {statusLabel({
                  granted: !!s?.fullScreenAllowed,
                  needsSettings: s ? !s.fullScreenAllowed : false,
                })}
              </li>
              <li>
                Категория входящих звонков —{' '}
                {statusLabel({
                  granted: !!s?.callChannelHighImportance,
                  needsSettings: s ? !s.callChannelHighImportance : false,
                })}
              </li>
            </ul>
            <div className="modal-actions">
              <button type="button" className="link-btn" onClick={() => { markCallOnboardingSkipped(); onClose(); }}>
                Позже
              </button>
              <button type="button" disabled={busy} onClick={() => setStep('notifications')}>
                Настроить звонки
              </button>
            </div>
          </>
        )}

        {step === 'notifications' && (
          <StepCard
            title="Разрешите уведомления"
            body="Они нужны, чтобы вы могли видеть входящие звонки, когда приложение закрыто или телефон заблокирован."
            status={statusLabel({
              granted: !!s?.notificationsGranted && !!s?.appNotificationsEnabled,
              needsSettings: !!s && s.notificationsGranted && !s.appNotificationsEnabled,
            })}
            busy={busy}
            primaryLabel="Разрешить уведомления"
            onPrimary={() =>
              void guard(async () => {
                const next = await requestNotificationPermission();
                if (!next.appNotificationsEnabled || !next.notificationsGranted) {
                  await openNotificationSettings();
                }
                return next;
              })
            }
            secondaryLabel="Открыть настройки"
            onSecondary={() => void guard(() => openNotificationSettings())}
            onNext={() => setStep('camera')}
          />
        )}

        {step === 'camera' && (
          <StepCard
            title="Камера"
            body="Нужна для передачи вашего видео после ответа на звонок. До ответа камера не включается."
            status={statusLabel({ granted: !!s?.cameraGranted })}
            busy={busy}
            primaryLabel="Разрешить камеру"
            onPrimary={() => void guard(() => requestMediaPermissionsState())}
            onNext={() => setStep('microphone')}
          />
        )}

        {step === 'microphone' && (
          <StepCard
            title="Микрофон"
            body="Нужен для голоса после ответа. До ответа микрофон не включается."
            status={statusLabel({ granted: !!s?.microphoneGranted })}
            busy={busy}
            primaryLabel="Разрешить микрофон"
            onPrimary={() => void guard(() => requestMediaPermissionsState())}
            onNext={() => setStep(s?.bluetoothRequired ? 'bluetooth' : 'fullscreen')}
          />
        )}

        {step === 'bluetooth' && (
          <StepCard
            title="Bluetooth-гарнитуры"
            body="Чтобы использовать наушники во время звонка."
            status={statusLabel({
              granted: !!s?.bluetoothGranted,
              notRequired: s ? !s.bluetoothRequired : false,
            })}
            busy={busy}
            primaryLabel="Разрешить Bluetooth"
            onPrimary={() => void guard(() => requestBluetoothPermission())}
            onNext={() => setStep('fullscreen')}
          />
        )}

        {step === 'fullscreen' && (
          <>
            <StepCard
              title="Полноэкранные звонки"
              body={
                s?.fullScreenAllowed
                  ? 'Разрешено системой.'
                  : 'Полноэкранные звонки запрещены системой. Без этого разрешения Samsung покажет только уведомление, но не откроет экран входящего звонка поверх блокировки.'
              }
              status={statusLabel({
                granted: !!s?.fullScreenAllowed,
                needsSettings: !!s && !s.fullScreenAllowed,
              })}
              busy={busy}
              primaryLabel="Разрешить полноэкранные звонки"
              onPrimary={() => void guard(() => openFullScreenCallSettings())}
              onNext={() => setStep('channel')}
            />
            {!s?.fullScreenAllowed && (
              <p className="call-perm-hint">
                На Samsung: Настройки → Приложения → ⋮ → Специальный доступ → Полноэкранные
                оповещения → Ямщик → Разрешить
              </p>
            )}
          </>
        )}

        {step === 'channel' && (
          <>
            <StepCard
              title="Категория входящих звонков"
              body="Канал должен быть с важностью «Оповещение» (не Silent), со звуком/вибрацией и показом на экране блокировки."
              status={statusLabel({
                granted: !!s?.callChannelHighImportance,
                needsSettings: !!s && !s.callChannelHighImportance,
              })}
              busy={busy}
              primaryLabel="Открыть категорию входящих звонков"
              onPrimary={() => void guard(() => openCallChannelSettings())}
              onNext={() => setStep('battery')}
            />
            <p className="call-perm-hint">
              Для Samsung Galaxy проверьте: Настройки → Уведомления → Уведомления приложений → Ямщик
              → Разрешить уведомления. Затем: Категории → Входящие звонки → Оповещение → Всплывающие
              → Экран блокировки. Также: Экран блокировки и AOD → Уведомления → Карточки.
            </p>
          </>
        )}

        {step === 'battery' && (
          <>
            <StepCard
              title="Работа в фоне"
              body="Samsung может ограничивать входящие звонки, если приложение помещено в спящий режим. Это рекомендация, не обязательное разрешение."
              status={
                s?.batteryOptimized
                  ? 'Нужно открыть настройки (рекомендация)'
                  : 'Без ограничений или не требуется'
              }
              busy={busy}
              primaryLabel="Открыть настройки батареи"
              onPrimary={() => void guard(() => openBatterySettings())}
              onNext={() => {
                void refresh().then((next) => {
                  markCallOnboardingDone(!!next.incomingCallsReady);
                  console.info(
                    next.incomingCallsReady
                      ? '[calls] CALL_ONBOARDING_COMPLETED'
                      : '[calls] CALL_ONBOARDING_INCOMPLETE',
                  );
                  setStep('done');
                });
              }}
              nextLabel="К диагностике"
            />
            <p className="call-perm-hint">
              Батарея → Без ограничений. Также: Обслуживание устройства → Батарея → Ограничения
              фонового использования → Никогда не спящие приложения.
            </p>
          </>
        )}

        {step === 'done' && (
          <>
            <p className="modal-subtitle">
              {s?.incomingCallsReady
                ? 'Входящие звонки готовы.'
                : 'Входящие звонки настроены не полностью — сообщения работают, звонки можно донастроить позже.'}
            </p>
            <ul className="call-perm-list">
              <li>Входящие: {s?.incomingCallsReady ? 'готовы' : 'не готовы'}</li>
              <li>Видеозвонки: {s?.activeVideoCallsReady ? 'готовы' : 'не готовы'}</li>
            </ul>
            <div className="modal-actions">
              {onOpenDiagnostics && (
                <button type="button" className="link-btn" onClick={onOpenDiagnostics}>
                  Диагностика
                </button>
              )}
              <button type="button" onClick={onClose}>
                Готово
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepCard(props: {
  title: string;
  body: string;
  status: string;
  busy: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onNext: () => void;
  nextLabel?: string;
}) {
  return (
    <>
      <h3 className="call-perm-step-title">{props.title}</h3>
      <p className="modal-subtitle">{props.body}</p>
      <p className="call-perm-status">Статус: {props.status}</p>
      <div className="modal-actions call-perm-actions">
        <button type="button" disabled={props.busy} onClick={props.onPrimary}>
          {props.primaryLabel}
        </button>
        {props.onSecondary && (
          <button type="button" className="link-btn" disabled={props.busy} onClick={props.onSecondary}>
            {props.secondaryLabel}
          </button>
        )}
        <button type="button" className="link-btn" onClick={props.onNext}>
          {props.nextLabel ?? 'Далее'}
        </button>
      </div>
    </>
  );
}
