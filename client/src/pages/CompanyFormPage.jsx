import { useForm } from 'react-hook-form';
import RegistrationForm, { CountrySelect, SelectInput, TextInput } from '../components/RegistrationForm';
import useRegistration from '../hooks/useRegistration';
import useMeta from '../hooks/useMeta';
import { companyPanRules, emailRules, pastDateRules, phoneRules, required, todayIso } from '../utils/validators';

export default function CompanyFormPage() {
  const form = useForm({
    mode: 'onTouched',
    defaultValues: {
      legalName: '', registrationNumber: '', panNumber: '', email: '', phone: '', address: '', country: 'IN', businessActivity: '', dateOfIncorporation: '',
    },
  });
  const { register, formState: { errors } } = form;
  const { onSubmit, submitting, formError } = useRegistration('Company', form);
  const activities = (useMeta().data?.businessActivities ?? []).map((a) => ({ value: a, label: a }));
  const f = { register, errors };

  return (
    <RegistrationForm title="Company Customer" subtitle="Register a new company customer" onSubmit={onSubmit} submitting={submitting} formError={formError}>
      <TextInput {...f} label="Legal company name" name="legalName" rules={required('Legal company name')} autoComplete="off" />
      <TextInput {...f} label="Company registration number" name="registrationNumber" rules={required('Company registration number')} placeholder="e.g. U12345MH2015PTC123456" />
      <TextInput {...f} label="Business PAN" name="panNumber" rules={companyPanRules} placeholder="ABCCD1234E" maxLength={10} style={{ textTransform: 'uppercase' }} hint="4th letter C for a company (F, H, A, T, B, L, J, G also accepted)" />
      <TextInput {...f} label="Date of incorporation" name="dateOfIncorporation" type="date" max={todayIso()} rules={pastDateRules('Date of incorporation')} />
      <TextInput {...f} label="Business email" name="email" type="email" rules={emailRules('Business email')} placeholder="accounts@company.com" />
      <TextInput {...f} label="Business phone" name="phone" type="tel" rules={phoneRules('Business phone')} placeholder="98765 43210 or +44 20 7946 0958" />
      <div className="sm:col-span-2">
        <TextInput {...f} label="Registered office address" name="address" rules={required('Registered office address')} />
      </div>
      <CountrySelect {...f} />
      <SelectInput {...f} label="Business activity / industry" name="businessActivity" options={activities} placeholder="Select an activity" rules={{ required: 'Business activity is required' }} />
    </RegistrationForm>
  );
}
