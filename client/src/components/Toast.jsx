import { createContext, useCallback, useContext, useState } from 'react';

/**
 * Tiny notification system.  const toast = useToast();  toast.success('Saved');
 * Toasts disappear by themselves after 6 seconds.
 */
const ToastContext = createContext(null);
let nextId = 1;

const STYLES = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  error: 'border-red-300 bg-red-50 text-red-900',
  info: 'border-slate-300 bg-white text-slate-800',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (type, message) => {
      const id = nextId++;
      setToasts((list) => [...list, { id, type, message }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss]
  );

  const api = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${STYLES[t.type]}`}>
            <span>{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="text-lg leading-none opacity-60 hover:opacity-100" aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
