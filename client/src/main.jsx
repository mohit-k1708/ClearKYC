import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './components/Toast';
import { MetaProvider } from './hooks/useMeta';
import { ReviewerProvider } from './hooks/useReviewer';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <MetaProvider>
          <ReviewerProvider>
            <App />
          </ReviewerProvider>
        </MetaProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
