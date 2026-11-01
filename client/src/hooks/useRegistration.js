import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createCustomer } from '../services/api';
import { useToast } from '../components/Toast';

/**
 * Shared submit logic for both registration forms.
 *  - blocks double submission (button disabled + a ref guard against rapid double clicks)
 *  - shows server-side field errors under the matching inputs
 *  - on success: toast with the generated Customer ID, then opens the customer profile
 */
export default function useRegistration(customerType, form) {
  const navigate = useNavigate();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const inFlight = useRef(false);

  const onSubmit = form.handleSubmit(async (values) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);

    // Trim whitespace in every text value before sending.
    const payload = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

    try {
      const customer = await createCustomer({ customerType, ...payload });
      toast.success(`Customer registered successfully. Customer ID: ${customer.customerId}`);
      navigate(`/customers/${customer.customerId}`, { state: { justRegistered: true } });
    } catch (err) {
      const known = Object.keys(form.getValues());
      Object.entries(err.fields || {})
        .filter(([name]) => known.includes(name))
        .forEach(([name, message]) => form.setError(name, { type: 'server', message }));
      setFormError(err);
      if (err.status === 0 || err.status >= 500) toast.error(err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  });

  return { onSubmit, submitting, formError };
}
