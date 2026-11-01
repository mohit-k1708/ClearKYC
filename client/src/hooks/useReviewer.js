import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react';
import { listReviewers } from '../services/kycApi';
import { setActingReviewer } from '../services/api';
import useAsync from './useAsync';

/**
 * "Acting as" selection. PROTOTYPE: there is no login, so the analyst picks which reviewer they are
 * acting as. The choice is remembered in this browser and sent as the X-Reviewer-Id header. The
 * server (and the database) still check that this person is allowed to record decisions.
 */
const ReviewerContext = createContext(null);
const STORAGE_KEY = 'clearkyc.reviewerId';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function ReviewerProvider({ children }) {
  const { data: reviewers, error, reload } = useAsync(listReviewers, []);
  const [selectedId, setSelectedId] = useState(readStored);

  const select = useCallback((id) => {
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage can be blocked; the choice then lasts for this visit only */
    }
  }, []);

  // Forget a stored choice that no longer exists (e.g. after the database was reset).
  useEffect(() => {
    if (reviewers && selectedId && !reviewers.some((r) => String(r.id) === selectedId)) select('');
  }, [reviewers, selectedId, select]);

  const current = reviewers?.find((r) => String(r.id) === selectedId) ?? null;
  useEffect(() => setActingReviewer(current ? current.id : null), [current]);

  const value = { reviewers: reviewers ?? [], current, select, error, reload };
  return createElement(ReviewerContext.Provider, { value }, children);
}

export default function useReviewer() {
  return useContext(ReviewerContext);
}
