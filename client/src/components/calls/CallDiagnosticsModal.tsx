import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import {
  getCallPermissionState,
  openAppSettings,
  openBatterySettings,
  openCallChannelSettings,
  openFullScreenCallSettings,
  openNotificationSettings,
  requestBluetoothPermission,
  requestMediaPermissionsState,
  requestNotificationPermission,
  startTestIncomingCall,
  type CallPermissionState,
} from '../../lib/call-permissions';
import { isNativeAndroid } from '../../lib/native-calls';

interface Props {
  onClose: () => void;
  onOpenOnboarding?: () => void;
}

export function CallDiagnosticsModal({ onClose, onOpenOnboarding }: Props) {
  const [state, setState] = useState<CallPermissionState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getCallPermissionState());
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

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const s = state;
  const samsungHint =
    (s?.manufacturer || '').toLowerCase() === 'samsung' ||
    (s?.model || '').toUpperCase().startsWith('SM-S926');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal call-perm-modal call-diag-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Диагностика звонков</h2>
        {!isNativeAndroid() ? (
          <p className="modal-subtitle">Только Android-приложение.</p>
        ) : (
          <>
            <dl className="call-diag-grid">
              <dt>Manufacturer</dt>
              <dd>{s?.manufacturer ?? '—'}</dd>
              <dt>Model</dt>
              <dd>{s?.model ?? '—'}</dd>
              <dt>Android SDK</dt>
              <dd>{s?.sdkInt ?? '—'}</dd>
              <dt>Application ID</dt>
              <dd>{s?.applicationId ?? '—'}</dd>
              <dt>Notifications permission</dt>
              <dd>{yn(s?.notificationsGranted)}</dd>
              <dt>App notifications enabled</dt>
              <dd>{yn(s?.appNotificationsEnabled)}</dd>
              <dt>Call channel ID</dt>
              <dd>{s?.callChannelId ?? '—'}</dd>
              <dt>Call channel importance</dt>
              <dd>{s?.callChannelImportance ?? '—'}</dd>
              <dt>Full-screen supported</dt>
              <dd>{yn(s?.fullScreenSupported)}</dd>
              <dt>Full-screen allowed</dt>
              <dd>{yn(s?.fullScreenAllowed)}</dd>
              <dt>Camera</dt>
              <dd>{yn(s?.cameraGranted)}</dd>
              <dt>Microphone</dt>
              <dd>{yn(s?.microphoneGranted)}</dd>
              <dt>Bluetooth</dt>
              <dd>
                {s?.bluetoothRequired === false ? 'n/a' : yn(s?.bluetoothGranted)}
              </dd>
              <dt>Battery optimization</dt>
              <dd>{s?.batteryOptimized ? 'optimized (info)' : 'unrestricted / ok'}</dd>
              <dt>incomingCallsReady</dt>
              <dd>{yn(s?.incomingCallsReady)}</dd>
              <dt>activeVideoCallsReady</dt>
              <dd>{yn(s?.activeVideoCallsReady)}</dd>
            </dl>

            {samsungHint && (
              <p className="call-perm-hint">
                Ожидается для S24+: manufacturer = samsung, model = SM-S926…, SDK = 34 или выше.
              </p>
            )}

            <div className="call-diag-actions">
              <button type="button" disabled={busy} onClick={() => void run(() => requestNotificationPermission())}>
                Запросить уведомления
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => requestMediaPermissionsState())}>
                Запросить камеру/микрофон
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => requestBluetoothPermission())}>
                Запросить Bluetooth
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => openFullScreenCallSettings())}>
                Открыть полноэкранные оповещения
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => openCallChannelSettings())}>
                Открыть категорию входящих звонков
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => openNotificationSettings())}>
                Открыть настройки уведомлений
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => openBatterySettings())}>
                Открыть настройки батареи
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => openAppSettings())}>
                Открыть настройки приложения
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await startTestIncomingCall();
                  })
                }
              >
                Тестовый входящий звонок
              </button>
              {onOpenOnboarding && (
                <button type="button" className="link-btn" onClick={onOpenOnboarding}>
                  Мастер настройки
                </button>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

function yn(v: boolean | undefined): string {
  if (v == null) return '—';
  return v ? 'yes' : 'no';
}
