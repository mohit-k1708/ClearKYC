import { createContext, createElement, useContext } from 'react';
import { getMeta } from '../services/api';
import useAsync from './useAsync';

// Reference data (countries, industries, risk model notes) is loaded once from the API.
const MetaContext = createContext(null);

export function MetaProvider({ children }) {
  const meta = useAsync(getMeta, []);
  return createElement(MetaContext.Provider, { value: meta }, children);
}

export default function useMeta() {
  return useContext(MetaContext);
}
