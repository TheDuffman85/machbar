import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Copy, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { localUserIdSchema } from '@machbar/shared';
import { ApiError } from './offline';

function decodeImage(source: CanvasImageSource, width: number, height: number): string | undefined {
  const scale = Math.min(1, 1200 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height)?.data;
}

export function UserIdentity({
  userId,
  disabled,
  pending,
  onSwitch,
}: {
  userId: string | null;
  disabled: boolean;
  pending: boolean;
  onSwitch: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [qr, setQr] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scanning, setScanning] = useState(false);
  const [reading, setReading] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const currentId = useRef<HTMLInputElement>(null);
  const nextId = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void QRCode.toDataURL(userId, { width: 256, margin: 4 }).then(
      (data) => {
        if (!cancelled) setQr(data);
      },
      () => {
        if (!cancelled) setError('QR_ERROR');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (disabled) setScanning(false);
  }, [disabled]);

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    const stop = () => stream?.getTracks().forEach((track) => track.stop());
    const scan = () => {
      if (cancelled) return;
      const element = video.current;
      if (element && element.readyState >= 2) {
        const decoded = decodeImage(element, element.videoWidth, element.videoHeight);
        if (decoded) {
          const parsed = localUserIdSchema.safeParse(decoded.trim());
          stop();
          setScanning(false);
          if (parsed.success) {
            setValue(parsed.data);
            setNotice(t('qrScanned'));
            nextId.current?.focus();
          } else setError('INVALID_IDENTITY');
          return;
        }
      }
      timer = window.setTimeout(scan, 250);
    };
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled || !video.current) {
          stop();
          return;
        }
        video.current.srcObject = stream;
        await video.current.play();
        scan();
      } catch {
        stop();
        if (!cancelled) {
          setScanning(false);
          setError('CAMERA_UNAVAILABLE');
        }
      }
    };
    const hide = () => {
      if (document.hidden) setScanning(false);
    };
    document.addEventListener('visibilitychange', hide);
    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
      document.removeEventListener('visibilitychange', hide);
    };
  }, [scanning, t]);

  async function readQr(file: File) {
    setError('');
    setNotice('');
    setScanning(false);
    setReading(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new ApiError('QR_ERROR');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = data;
      await image.decode();
      const decoded = decodeImage(image, image.naturalWidth, image.naturalHeight);
      if (!decoded) throw new ApiError('QR_NOT_FOUND');
      const parsed = localUserIdSchema.safeParse(decoded.trim());
      if (!parsed.success) throw new ApiError('INVALID_IDENTITY');
      setValue(parsed.data);
      setNotice(t('qrScanned'));
      nextId.current?.focus();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'QR_ERROR');
    } finally {
      setReading(false);
    }
  }

  async function switchUser(event: FormEvent) {
    event.preventDefault();
    if (disabled || reading) return;
    setError('');
    setNotice('');
    setScanning(false);
    try {
      await onSwitch(value);
      setNotice(t('userSwitched'));
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
    }
  }

  async function copyId() {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setNotice(t('idCopied'));
    } catch {
      currentId.current?.select();
      setNotice(t('copyIdManually'));
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('userIdentity')}</h1>
          <p>{t('userIdentitySubtitle')}</p>
        </div>
      </div>
      <div className={`settings-grid identity-grid ${userId ? '' : 'identity-selection'}`}>
        {userId && (
          <section className="panel settings-panel">
            <h2>{t('yourUserId')}</h2>
            <p>{t('userIdHelp')}</p>
            {qr && (
              <img className="identity-qr" src={qr} alt={t('userIdQr')} width={256} height={256} />
            )}
            <form onSubmit={(event) => event.preventDefault()}>
              <label>
                {t('currentUserId')}
                <input ref={currentId} readOnly value={userId} spellCheck={false} />
              </label>
              <button type="button" className="button secondary" onClick={() => void copyId()}>
                <Copy size={16} />
                {t('copyUserId')}
              </button>
            </form>
            <p className="identity-hint">{t('userIdPrivacy')}</p>
          </section>
        )}
        <section className="panel settings-panel">
          <h2>{t('switchUser')}</h2>
          <p>{t(userId ? 'switchUserHelp' : 'selectUserHelp')}</p>
          <form onSubmit={(event) => void switchUser(event)}>
            <label>
              {t('existingUserId')}
              <input
                ref={nextId}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError('');
                  setNotice('');
                }}
                required
                maxLength={100}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled || reading}
              />
            </label>
            <div className="identity-actions">
              <button
                type="button"
                className="button secondary"
                disabled={disabled || reading}
                onClick={() => {
                  setError('');
                  setNotice('');
                  setScanning(!scanning);
                }}
              >
                <Camera size={16} />
                {t(scanning ? 'stopScan' : 'scanQr')}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={disabled || reading}
                onClick={() => fileInput.current?.click()}
              >
                <QrCode size={16} />
                {t('uploadQr')}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                aria-label={t('uploadQr')}
                disabled={disabled || reading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void readQr(file);
                }}
              />
            </div>
            {scanning && <video className="identity-camera" ref={video} muted playsInline />}
            <p className="muted identity-hint">{t('cameraHelp')}</p>
            {pending && <p className="muted">{t('switchPending')}</p>}
            <button className="button primary" disabled={disabled || reading || !value.trim()}>
              {t('switchUser')}
            </button>
          </form>
        </section>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
