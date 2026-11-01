/**
 * Client-side form rules (react-hook-form `rules`). They give instant feedback and mirror the
 * server's rules, but the SERVER is the authority and re-validates everything.
 *
 * Reminder: these checks verify FORMAT only. A well-formed PAN or Aadhaar number is not proof
 * that the number is genuine or belongs to the customer.
 */
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COMPANY_PAN_HOLDER_TYPES = ['C', 'F', 'H', 'A', 'T', 'B', 'L', 'J', 'G'];

export const required = (label) => ({ validate: (v) => (v ?? '').toString().trim() !== '' || `${label} is required` });

export const emailRules = (label) => ({
  validate: {
    required: (v) => (v ?? '').trim() !== '' || `${label} is required`,
    format: (v) => EMAIL_FORMAT.test(v.trim()) || `${label} must be in a valid format (name@example.com)`,
  },
});

export const phoneRules = (label) => ({
  validate: {
    required: (v) => (v ?? '').trim() !== '' || `${label} is required`,
    format: (v) => {
      const cleaned = v.replace(/[\s-]/g, '');
      return (
        /^(?:\+91|91|0)?[6-9][0-9]{9}$/.test(cleaned) ||
        /^\+[1-9][0-9]{7,14}$/.test(cleaned) ||
        `${label} is not valid (use a 10-digit Indian mobile number or +<country code><number>)`
      );
    },
  },
});

const panRules = (label, holderTypes, holderHint) => ({
  validate: {
    required: (v) => (v ?? '').trim() !== '' || `${label} is required`,
    format: (v) => PAN_FORMAT.test(v.trim().toUpperCase()) || `${label} must follow the PAN format AAAAA9999A (5 letters, 4 digits, 1 letter)`,
    holder: (v) => holderTypes.includes(v.trim().toUpperCase()[3]) || `${label}: the 4th letter should be ${holderHint}`,
  },
});
export const individualPanRules = panRules('PAN number', ['P'], '"P" for an individual');
export const companyPanRules = panRules('Business PAN', COMPANY_PAN_HOLDER_TYPES, `one of ${COMPANY_PAN_HOLDER_TYPES.join(', ')} for a non-individual entity`);

export const aadhaarRules = {
  validate: {
    required: (v) => (v ?? '').trim() !== '' || 'Aadhaar number is required',
    format: (v) => /^[0-9]{12}$/.test(v.replace(/[\s-]/g, '')) || 'Aadhaar number must contain exactly 12 digits',
  },
};

const today = () => new Date().toISOString().slice(0, 10);
export const todayIso = today;

export const pastDateRules = (label, { minAge } = {}) => ({
  validate: {
    required: (v) => !!v || `${label} is required`,
    notFuture: (v) => v <= today() || `${label} cannot be in the future`,
    age: (v) => {
      if (!minAge) return true;
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - minAge);
      return v <= cutoff.toISOString().slice(0, 10) || `Customer must be at least ${minAge} years old`;
    },
  },
});
