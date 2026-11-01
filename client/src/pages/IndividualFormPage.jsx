import { useForm } from 'react-hook-form';
import RegistrationForm, { CountrySelect, TextInput } from '../components/RegistrationForm';
import useRegistration from '../hooks/useRegistration';
import useMeta from '../hooks/useMeta';
import { aadhaarRules, emailRules, individualPanRules, pastDateRules, phoneRules, required, todayIso } from '../utils/validators';

export default function IndividualFormPage() {
  const form = useForm({
    mode: 'onTouched',
    defaultValues: { fullName: '', dateOfBirth: '', email: '', phone: '', address: '', panNumber: '', aadhaarNumber: '', occupation: '', country: 'IN' },
  });
  const { register, formState: { errors } } = form;
  const { onSubmit, submitting, formError } = useRegistration('Individual', form);
  const occupations = useMeta().data?.occupations ?? [];
  const f = { register, errors };

  return (
    <RegistrationForm title="Individual Customer" subtitle="Register a new individual customer" onSubmit={onSubmit} submitting={submitting} formError={formError}>
      <TextInput {...f} label="Full name" name="fullName" rules={required('Full name')} autoComplete="off" />
      <TextInput {...f} label="Date of birth" name="dateOfBirth" type="date" max={todayIso()} rules={pastDateRules('Date of birth', { minAge: 18 })} />
      <TextInput {...f} label="Email address" name="email" type="email" rules={emailRules('Email address')} placeholder="name@example.com" />
      <TextInput {...f} label="Phone number" name="phone" type="tel" rules={phoneRules('Phone number')} placeholder="98765 43210 or +44 20 7946 0958" />
      <div className="sm:col-span-2">
        <TextInput {...f} label="Residential address" name="address" rules={required('Residential address')} />
      </div>
      <TextInput {...f} label="PAN number" name="panNumber" rules={individualPanRules} placeholder="ABCPD1234E" maxLength={10} style={{ textTransform: 'uppercase' }} hint="Format: 5 letters, 4 digits, 1 letter (4th letter P for individuals)" />
      <TextInput {...f} label="Aadhaar number" name="aadhaarNumber" rules={aadhaarRules} placeholder="1234 5678 9012" inputMode="numeric" maxLength={14} hint="Exactly 12 digits" />
      <TextInput {...f} label="Occupation" name="occupation" list="occupation-options" rules={required('Occupation')} hint="Pick a suggestion or type your own" />
      <datalist id="occupation-options">
        {occupations.map((o) => <option key={o} value={o} />)}
      </datalist>
      <CountrySelect {...f} />
    </RegistrationForm>
  );
}
