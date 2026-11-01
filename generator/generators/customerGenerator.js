/**
 * Customers (Task 6): fictional people and companies with consistent, rule-valid field combinations.
 *
 * Nothing real is used: names come from small fictional pools, PAN and Aadhaar are placeholders that only follow the FORMAT
 * (PAN starts with the marker letter Z; Aadhaar numbers are random 12-digit strings), e-mails use example.com / *.example.com.
 * Customers are numbered in the order they were onboarded, so older customers have lower IDs.
 */
const { parseIso, addDays, addMonths } = require('../../server/src/utils/dates');
const { BUSINESS_ACTIVITIES } = require('../../server/src/config/options');
const { RISK_RULES } = require('../../server/src/config/riskRules');
const { customerCode } = require('../utils/idGenerator');
const { encryptDeterministic, blindIndex } = require('../utils/syntheticCrypto');

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Rohan', 'Arjun', 'Neel', 'Ananya', 'Diya', 'Meera', 'Saanvi', 'Kavya', 'Isha', 'Riya', 'Tara', 'Farhan', 'Zoya', 'Karan', 'Pooja',
  'Aryan', 'Dev', 'Harsh', 'Nikhil', 'Yash', 'Sneha', 'Priyanka', 'Anjali', 'Divya', 'Lakshmi', 'Rahul', 'Suresh', 'Imran', 'Fatima', 'Gauri', 'Manav', 'Tanvi', 'Varun', 'Nisha', 'Omkar'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Gupta', 'Mehta', 'Khan', 'Bose', 'Das', 'Joshi', 'Kulkarni', 'Chopra', 'Menon', 'Rao', 'Singh', 'Pillai',
  'Banerjee', 'Desai', 'Malhotra', 'Kapoor', 'Saxena', 'Bhatt', 'Naidu', 'Shetty', 'Ghosh', 'Thakur', 'Agarwal', 'Chatterjee', 'Yadav', 'Mishra'];
const COMPANY_A = ['Bluewave', 'Orchid', 'Nimbus', 'Cedar', 'Sunrise', 'Pioneer', 'Lotus', 'Granite', 'Horizon', 'Silverline', 'Evergreen', 'Zenith', 'Crescent', 'Harbour', 'Summit', 'Meridian', 'Aurora', 'Banyan', 'Coral', 'Delta'];
const COMPANY_B = ['Technologies', 'Industries', 'Traders', 'Logistics', 'Foods', 'Healthcare', 'Constructions', 'Exports', 'Solutions', 'Ventures', 'Textiles', 'Pharma', 'Energy', 'Retail', 'Services'];
const COMPANY_SUFFIX = [['Pvt Ltd', 5], ['Ltd', 2], ['LLP', 2], ['Pvt Ltd', 3]];
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Pune', 'Hyderabad', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Kochi', 'Lucknow', 'Indore', 'Surat', 'Nagpur'];
const STREETS = ['MG Road', 'Park Street', 'Station Road', 'Lake View Lane', 'Residency Road', 'Temple Street', 'Gandhi Nagar', 'Market Road', 'Ring Road', 'Civil Lines'];
const FOREIGN = ['US', 'GB', 'SG', 'AE', 'CA', 'AU', 'DE'];
const OCCUPATION_WEIGHTS = [['Salaried Employee', 30], ['Self-employed', 14], ['Business Owner', 10], ['Doctor', 5], ['Engineer', 9], ['Teacher', 6], ['Farmer', 4], ['Student', 6], ['Retired', 6], ['Homemaker', 5],
  ['Government Official', 4], ['Politician / Elected Representative', 0.8], ['Jeweller', 1.6], ['Real Estate Agent', 2]];
const ACTIVITY_WEIGHTS = BUSINESS_ACTIVITIES.map((a) => [a, { 'Information Technology': 18, Manufacturing: 14, Retail: 14, Healthcare: 8, Education: 6, Agriculture: 5, Construction: 8, 'Financial Services': 6, 'Real Estate': 7, 'Jewellery & Precious Metals': 4, 'Import / Export Trading': 7, 'Casinos & Gaming': 1.6, 'Virtual Assets / Crypto': 1.6, 'Money Services / Remittance': 2, 'Non-profit / NGO': 2, Other: 3 }[a] ?? 1]);

const at = (iso, rng) => new Date(`${iso}T${String(rng.int(8, 18)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}.000Z`);

// Portfolio mix by country: mostly domestic, some standard foreign exposure, a few customers in the (illustrative) elevated and
// high-risk jurisdictions that config/riskRules.js lists. The RISK RULES are not touched: only how often each situation occurs.
const ELEVATED = RISK_RULES.country.elevated.codes;
const HIGH = RISK_RULES.country.high.codes;

function pickCountry(rng) {
  const roll = rng.next();
  if (roll < 0.82) return 'IN';
  if (roll < 0.93) return rng.pick(FOREIGN);
  if (roll < 0.98) return rng.pick(ELEVATED);
  return rng.pick(HIGH);
}

/** Builds all customers in memory. Returns them numbered by onboarding date. */
function generateCustomers(cfg, rng) {
  const { customers: total, companies } = cfg.counts;
  const r = rng.fork('customers');
  const ref = cfg.referenceDate;
  const companySlots = new Set(r.shuffle(Array.from({ length: total }, (_, i) => i)).slice(0, companies));

  // 1. when each customer was onboarded (more recent customers are more common)
  const drafts = Array.from({ length: total }, (_, i) => {
    const offset = Math.floor(cfg.ratios.onboardingWindowDays * r.next() ** cfg.ratios.recentBias);
    return { index: i, isCompany: companySlots.has(i), onboardedDay: addDays(ref, -offset) };
  });
  drafts.forEach((d) => { d.onboardedAt = at(d.onboardedDay, r); });
  drafts.sort((a, b) => a.onboardedAt - b.onboardedAt || a.index - b.index);

  const usedPan = new Set();
  const usedAadhaar = new Set();
  const usedReg = new Set();
  const usedCompanyNames = new Set();
  const unique = (set, make) => { let v; do v = make(); while (set.has(v)); set.add(v); return v; };

  return drafts.map((d, i) => {
    const id = i + 1;
    const code = customerCode(id);
    const country = pickCountry(r);
    const base = { id, code, isCompany: d.isCompany, onboardedAt: d.onboardedAt, onboardedDay: d.onboardedDay, country };
    const address = `${r.int(1, 250)}, ${r.pick(STREETS)}, ${r.pick(CITIES)}${country === 'IN' ? '' : ' (overseas address)'}`;
    const phone = `+91${r.pick(['6', '7', '8', '9'])}${r.digits(9)}`;

    if (!d.isCompany) {
      const first = r.pick(FIRST);
      const last = r.pick(LAST);
      const age = r.int(18, 82);
      const dob = addDays(addMonths(d.onboardedDay, -12 * age), -r.int(0, 364)); // at least `age` whole years old on the onboarding day
      const occupation = r.weighted(OCCUPATION_WEIGHTS);
      const pan = unique(usedPan, () => `Z${r.letters(2)}P${r.letters(1)}${r.digits(4)}${r.letters(1)}`);
      const aadhaar = unique(usedAadhaar, () => `${r.int(2, 9)}${r.digits(11)}`);
      const fullName = `${first} ${last}`;
      return {
        ...base, type: 'Individual', typeId: 1, fullName, dateOfBirth: dob, occupation, businessActivity: null, dateOfIncorporation: null, pan,
        row: {
          id, customerCode: code, customerTypeId: 1, fullName, email: `${first}.${last}${id}@example.com`.toLowerCase(), phone, address, country,
          panNumber: encryptDeterministic(pan), aadhaarNumber: encryptDeterministic(aadhaar), panHash: blindIndex('PAN', pan), aadhaarHash: blindIndex('AADHAAR', aadhaar),
          dateOfBirth: parseIso(dob), occupation, companyRegistrationNumber: null, businessActivity: null, dateOfIncorporation: null,
          registrationStatus: 'Registered', createdAt: d.onboardedAt, updatedAt: d.onboardedAt,
        },
      };
    }

    let name = `${r.pick(COMPANY_A)} ${r.pick(COMPANY_B)} ${r.weighted(COMPANY_SUFFIX)}`;
    if (usedCompanyNames.has(name)) name = `${name.replace(/ (Pvt Ltd|Ltd|LLP)$/, '')} ${r.pick(CITIES)} ${name.match(/(Pvt Ltd|Ltd|LLP)$/)[0]}`;
    while (usedCompanyNames.has(name)) name = `${name} ${r.int(2, 99)}`;
    usedCompanyNames.add(name);
    const activity = r.weighted(ACTIVITY_WEIGHTS);
    // 12% are newly incorporated (the risk rules treat a company under a year old differently)
    const incorporated = r.chance(0.12) ? addDays(d.onboardedDay, -r.int(5, 330)) : addDays(d.onboardedDay, -r.int(400, 9000));
    const incYear = Number(incorporated.slice(0, 4));
    const reg = unique(usedReg, () => `U${r.digits(5)}MH${incYear}PTC${r.digits(6)}`);
    const pan = unique(usedPan, () => `Z${r.letters(2)}${r.weighted([['C', 6], ['F', 1.5], ['T', 1]])}${r.letters(1)}${r.digits(4)}${r.letters(1)}`);
    const slug = name.split(' ')[0].toLowerCase();
    return {
      ...base, type: 'Company', typeId: 2, fullName: name, dateOfBirth: null, occupation: null, businessActivity: activity, dateOfIncorporation: incorporated, pan,
      row: {
        id, customerCode: code, customerTypeId: 2, fullName: name, email: `contact${id}@${slug}-demo.example.com`, phone, address, country,
        panNumber: encryptDeterministic(pan), aadhaarNumber: null, panHash: blindIndex('PAN', pan), aadhaarHash: null,
        dateOfBirth: null, occupation: null, companyRegistrationNumber: reg, businessActivity: activity, dateOfIncorporation: parseIso(incorporated),
        registrationStatus: 'Registered', createdAt: d.onboardedAt, updatedAt: d.onboardedAt,
      },
    };
  });
}

module.exports = { generateCustomers, FIRST, LAST, CITIES, at };
