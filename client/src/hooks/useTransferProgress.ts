import { useEffect, useState } from 'react';
import {
  progressForMessage,
  subscribeTransferProgress,
  type TransferProgress,
} from '../lib/transfer-progress';

export function useTransferProgress(msg: {
  id: string;
  clientId?: string;
  imageId?: string;
}): TransferProgress | undefined {
  const [, setTick] = useState(0);
  useEffect(() => subscribeTransferProgress(() => setTick((n) => n + 1)), []);
  return progressForMessage(msg);
}
