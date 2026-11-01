import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async function whenever `deps` change and tracks { data, loading, error }.
 * Stale responses (from an older request) are ignored, so fast typing in a search box
 * can never show results from an earlier query.
 */
export default function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const requestId = useRef(0);

  const run = useCallback(() => {
    const id = ++requestId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => id === requestId.current && setState({ data, loading: false, error: null }))
      .catch((error) => id === requestId.current && setState({ data: null, loading: false, error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { ...state, reload: run };
}
