/**
 * Idempotent Seed Script for MongoDB Atlas.
 * 
 * Creates:
 * 1. Default Super Admin account using ADMIN_EMAIL and ADMIN_PASSWORD from .env.
 *    - Password is encrypted/hashed exactly once.
 *    - Updates password only when --reset-admin flag is passed.
 * 2. Real 12-service municipal catalog using atomic upserts with structured requiredDocuments.
 * 3. Municipal departments catalog.
 * 
 * Running multiple times is safe and never creates duplicates.
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const { connectDB, closeDB } = require('../config/db');
const User = require('../models/User');
const Service = require('../models/Service');
const Department = require('../models/Department');

const CATALOG_PATH = path.join(__dirname, '..', 'backend', 'config', 'services_catalog.json');

// Built-in fallback catalog of all 12 official municipal services
const FALLBACK_CATALOG = [
  {
    slug: 'birth-certificate',
    name: 'Birth Certificate Issuance',
    category: 'Revenue & Public Records',
    description: 'Apply for official municipal birth registration certificate.',
    sla_days: 7,
    fee: 50,
    requiredDocuments: [
      { key: 'hospital_discharge_summary', label: 'Hospital Discharge Summary', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'parent_id_proof', label: 'Parent ID Proof', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'marriage_certificate', label: 'Marriage Certificate', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Hospital Discharge Summary', 'Parent ID Proof', 'Marriage Certificate'],
    form_schema: [
      { name: 'child_name', label: 'Child Full Name', type: 'text', required: true },
      { name: 'dob', label: 'Date of Birth', type: 'date', required: true },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'], required: true },
      { name: 'place_of_birth', label: 'Place of Birth / Hospital', type: 'text', required: true },
      { name: 'father_name', label: 'Father Full Name', type: 'text', required: true },
      { name: 'mother_name', label: 'Mother Full Name', type: 'text', required: true }
    ]
  },
  {
    slug: 'death-certificate',
    name: 'Death Certificate Issuance',
    category: 'Revenue & Public Records',
    description: 'Official death certificate registration and issuance.',
    sla_days: 7,
    fee: 50,
    requiredDocuments: [
      { key: 'hospital_death_report', label: 'Hospital Death Report', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'id_proof_deceased', label: 'ID Proof of Deceased', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'applicant_id_proof', label: 'Applicant ID Proof', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Hospital Death Report', 'ID Proof of Deceased', 'Applicant ID Proof'],
    form_schema: [
      { name: 'deceased_name', label: 'Deceased Person Name', type: 'text', required: true },
      { name: 'date_of_death', label: 'Date of Death', type: 'date', required: true },
      { name: 'place_of_death', label: 'Place of Death', type: 'text', required: true },
      { name: 'cause_of_death', label: 'Cause of Death', type: 'text', required: false }
    ]
  },
  {
    slug: 'property-tax-assessment',
    name: 'Property Tax Assessment & Mutation',
    category: 'Revenue & Property Tax',
    description: 'Assessment of property valuation and ownership title mutation.',
    sla_days: 15,
    fee: 500,
    requiredDocuments: [
      { key: 'sale_deed', label: 'Registered Sale Deed', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'previous_tax_receipts', label: 'Previous Tax Receipts', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'electricity_bill', label: 'Electricity Bill', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Registered Sale Deed', 'Previous Tax Receipts', 'Electricity Bill'],
    form_schema: [
      { name: 'property_id', label: 'Property Assessment Number', type: 'text', required: true },
      { name: 'owner_name', label: 'Current Owner Full Name', type: 'text', required: true },
      { name: 'property_address', label: 'Property Address', type: 'textarea', required: true },
      { name: 'plot_area_sqft', label: 'Total Area in Sq. Feet', type: 'number', required: true }
    ]
  },
  {
    slug: 'water-tap-connection',
    name: 'New Water Tap Connection',
    category: 'Water Supply & Sewerage',
    description: 'Apply for residential or commercial piped potable water supply connection.',
    sla_days: 10,
    fee: 1200,
    requiredDocuments: [
      { key: 'proof_of_ownership', label: 'Proof of Ownership / Tax Receipt', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'site_blueprint', label: 'Site Blueprint / Plan', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Proof of Ownership / Tax Receipt', 'Site Blueprint / Plan'],
    form_schema: [
      { name: 'connection_type', label: 'Connection Type', type: 'select', options: ['Domestic', 'Commercial', 'Industrial'], required: true },
      { name: 'pipe_size_inches', label: 'Required Pipe Diameter (Inches)', type: 'select', options: ['0.5', '0.75', '1.0'], required: true },
      { name: 'premises_address', label: 'Installation Address', type: 'textarea', required: true }
    ]
  },
  {
    slug: 'trade-license',
    name: 'New Trade / Business License',
    category: 'Trade & Commerce',
    description: 'Statutory municipal operating license for shops, establishments, and enterprises.',
    sla_days: 14,
    fee: 1500,
    requiredDocuments: [
      { key: 'rental_agreement', label: 'Rental Agreement / Property Deed', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'pan_card', label: 'PAN Card', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'fire_safety_noc', label: 'Fire Safety NOC', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Rental Agreement / Property Deed', 'PAN Card', 'Fire Safety NOC'],
    form_schema: [
      { name: 'business_name', label: 'Trade / Business Name', type: 'text', required: true },
      { name: 'business_type', label: 'Nature of Trade', type: 'text', required: true },
      { name: 'operating_address', label: 'Shop / Establishment Address', type: 'textarea', required: true }
    ]
  },
  {
    slug: 'building-plan-sanction',
    name: 'Building Plan Approval & Sanction',
    category: 'Town Planning & Architecture',
    description: 'Architectural blueprint review and construction sanction permit.',
    sla_days: 30,
    fee: 3000,
    requiredDocuments: [
      { key: 'architectural_plan', label: 'Architectural Drawing Plan', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'title_deed', label: 'Title Deed', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'structural_certificate', label: 'Structural Stability Certificate', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Architectural Drawing Plan', 'Title Deed', 'Structural Stability Certificate'],
    form_schema: [
      { name: 'survey_number', label: 'Survey / Khasra Number', type: 'text', required: true },
      { name: 'construction_type', label: 'Construction Type', type: 'select', options: ['Residential', 'Commercial', 'Institutional'], required: true },
      { name: 'floors_count', label: 'Number of Proposed Floors', type: 'number', required: true }
    ]
  },
  {
    slug: 'marriage-certificate',
    name: 'Marriage Registration Certificate',
    category: 'Revenue & Public Records',
    description: 'Registration of solemnized marriage under municipal civic registry.',
    sla_days: 7,
    fee: 100,
    requiredDocuments: [
      { key: 'wedding_card', label: 'Wedding Invitation Card', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'id_proofs_couple', label: 'ID & Age Proofs of Groom and Bride', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'witness_ids', label: 'Witness IDs', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Wedding Invitation Card', 'ID & Age Proofs of Groom and Bride', 'Witness IDs'],
    form_schema: [
      { name: 'groom_name', label: 'Groom Full Name', type: 'text', required: true },
      { name: 'bride_name', label: 'Bride Full Name', type: 'text', required: true },
      { name: 'marriage_date', label: 'Date of Marriage', type: 'date', required: true },
      { name: 'venue', label: 'Marriage Venue', type: 'text', required: true }
    ]
  },
  {
    slug: 'road-cutting-permission',
    name: 'Road Cutting & Right-of-Way Permit',
    category: 'Engineering & Public Works',
    description: 'Permission for utility trenching, fiber laying, or pipeline installation.',
    sla_days: 10,
    fee: 2500,
    requiredDocuments: [
      { key: 'agency_registration', label: 'Agency Registration', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'route_map', label: 'Route Alignment Map', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'security_deposit', label: 'Reinstatement Security Deposit', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Agency Registration', 'Route Alignment Map', 'Reinstatement Security Deposit'],
    form_schema: [
      { name: 'purpose', label: 'Utility Purpose', type: 'text', required: true },
      { name: 'location_stretch', label: 'Road Stretch / Street Name', type: 'textarea', required: true },
      { name: 'length_meters', label: 'Trench Length in Meters', type: 'number', required: true }
    ]
  },
  {
    slug: 'street-light-repair',
    name: 'Street Lighting Fault Rectification',
    category: 'Electrical & Lighting',
    description: 'Request pole maintenance, LED fixture replacement, or darkness rectification.',
    sla_days: 3,
    fee: 0,
    // ZERO required documents
    requiredDocuments: [],
    required_documents: [],
    form_schema: [
      { name: 'pole_number', label: 'Nearest Electric Pole Number', type: 'text', required: false },
      { name: 'street_name', label: 'Street / Colony Name', type: 'text', required: true },
      { name: 'fault_description', label: 'Fault Details (Flickering / Unlit / Broken)', type: 'textarea', required: true }
    ]
  },
  {
    slug: 'garbage-clearance-request',
    name: 'Special Garbage & Bulk Waste Clearance',
    category: 'Sanitation & Solid Waste Management',
    description: 'Request dedicated municipal pickup for construction debris or garden waste.',
    sla_days: 2,
    fee: 200,
    // ZERO required documents
    requiredDocuments: [],
    required_documents: [],
    form_schema: [
      { name: 'waste_type', label: 'Category of Waste', type: 'select', options: ['Debris', 'Horticulture / Garden', 'Bulk Dry Waste'], required: true },
      { name: 'estimated_volume', label: 'Estimated Quantity (e.g. 1 Tractor Load)', type: 'text', required: true },
      { name: 'pickup_location', label: 'Exact Pickup Location Address', type: 'textarea', required: true }
    ]
  },
  {
    slug: 'underground-drainage-connection',
    name: 'Underground Drainage (UGD) Connection',
    category: 'Water Supply & Sewerage',
    description: 'Domestic and commercial connection to municipal underground sewerage system.',
    sla_days: 12,
    fee: 1000,
    requiredDocuments: [
      { key: 'property_tax_receipt', label: 'Property Tax Receipt', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 },
      { key: 'drainage_layout', label: 'Site Drainage Layout', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Property Tax Receipt', 'Site Drainage Layout'],
    form_schema: [
      { name: 'property_type', label: 'Property Type', type: 'select', options: ['Residential', 'Commercial'], required: true },
      { name: 'premises_address', label: 'Premises Address', type: 'textarea', required: true }
    ]
  },
  {
    slug: 'pet-license',
    name: 'Domestic Dog / Pet Registration',
    category: 'Veterinary & Animal Care',
    description: 'Annual registration and anti-rabies vaccination certificate issuance for pets.',
    sla_days: 5,
    fee: 100,
    requiredDocuments: [
      { key: 'vaccination_card', label: 'Veterinary Vaccination Card', required: true, allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5 }
    ],
    required_documents: ['Veterinary Vaccination Card'],
    form_schema: [
      { name: 'pet_name', label: 'Pet Name', type: 'text', required: true },
      { name: 'breed', label: 'Breed', type: 'text', required: true },
      { name: 'vaccination_date', label: 'Last Anti-Rabies Vaccination Date', type: 'date', required: true }
    ]
  }
];

async function seed() {
  console.log('\n' + '='.repeat(68));
  console.log('   MUNICIPAL SERVICE PORTAL - MONGODB ATLAS SEED INITIALIZATION');
  console.log('='.repeat(68));

  await connectDB();

  const resetAdminFlag = process.argv.includes('--reset-admin');

  // 1. Seed Super Admin
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@municipal.gov').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const adminName = process.env.ADMIN_NAME || 'Municipal Administrator';

  const existingAdmin = await User.findOne({
    email: adminEmail,
    is_deleted: { $ne: true }
  });

  if (existingAdmin) {
    if (resetAdminFlag) {
      const pwdHash = await User.hashPassword(adminPassword);
      existingAdmin.password_hash = pwdHash;
      existingAdmin.full_name = adminName;
      existingAdmin.role = 'super_admin';
      existingAdmin.admin_role = 'super_admin';
      existingAdmin.status = 'active';
      existingAdmin.is_active = true;
      existingAdmin.is_verified = true;
      existingAdmin.failed_login_attempts = 0;
      existingAdmin.locked_until = null;
      await existingAdmin.save();
      console.log(`[✓] Super Admin password and profile reset (--reset-admin flag passed): ${adminEmail}`);
    } else {
      existingAdmin.role = 'super_admin';
      existingAdmin.admin_role = 'super_admin';
      existingAdmin.status = 'active';
      existingAdmin.is_active = true;
      existingAdmin.is_verified = true;
      await existingAdmin.save();
      console.log(`[i] Super Admin exists: ${adminEmail} (password kept; pass --reset-admin to update).`);
    }
  } else {
    const pwdHash = await User.hashPassword(adminPassword);
    await User.create({
      full_name: adminName,
      email: adminEmail,
      mobile: '+91 99999 00000',
      address: 'Municipal Administrative Headquarters, Civic Center',
      password_hash: pwdHash,
      role: 'super_admin',
      admin_role: 'super_admin',
      status: 'active',
      is_active: true,
      is_verified: true,
      is_deleted: false
    });
    console.log(`[✓] Super Admin created: ${adminEmail}`);
  }

  // 2. Seed Official 12-Service Catalog with structured requiredDocuments
  console.log(`\n[i] Syncing ${FALLBACK_CATALOG.length} official services into MongoDB...`);

  let syncedCount = 0;
  const departmentsSet = new Set();

  for (const srv of FALLBACK_CATALOG) {
    if (!srv.slug) continue;
    departmentsSet.add(srv.category);

    await Service.findOneAndUpdate(
      { slug: srv.slug },
      {
        $set: {
          slug: srv.slug,
          name: srv.name,
          category: srv.category,
          description: srv.description || '',
          availability: 'Available',
          sla_days: srv.sla_days || 7,
          fee: srv.fee || 0,
          requiredDocuments: srv.requiredDocuments || [],
          required_documents: srv.required_documents || [],
          form_schema: srv.form_schema || [],
          is_deleted: false
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    syncedCount++;
  }
  console.log(`[✓] Successfully upserted ${syncedCount} municipal services with structured requiredDocuments.`);

  // 3. Seed Departments from Categories
  for (const dept of departmentsSet) {
    await Department.findOneAndUpdate(
      { name: dept },
      { $set: { name: dept, is_active: true } },
      { upsert: true }
    );
  }
  console.log(`[✓] Synced ${departmentsSet.size} municipal departments.`);

  console.log('='.repeat(68));
  console.log('   SEED COMPLETED SUCCESSFULLY (No mock citizen/application records)');
  console.log('='.repeat(68) + '\n');

  await closeDB();
}

seed().catch((err) => {
  console.error('[!] Seed failed:', err);
  process.exit(1);
});
