#!/usr/bin/env node

/**
 * One-time script to generate a self-signed .p12 certificate for PDF digital signing.
 *
 * Usage: npx tsx backend/scripts/generate-signing-cert.ts
 *
 * Outputs: backend/paralegix-signing.p12 (gitignored)
 *
 * The certificate is self-signed, so Adobe Reader will show:
 *   "Signed by Paralegix — identity not verified" (yellow triangle)
 * Tamper detection works identically to a paid certificate.
 * To get a green checkmark, replace with an AATL certificate — zero code changes.
 */

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'paralegix-signing.p12');
const PASSPHRASE = ''; // Empty passphrase — the .p12 file is gitignored and server-side only

// Check if certificate already exists
if (fs.existsSync(OUTPUT_PATH)) {
  process.exit(0);
}

// Generate a 2048-bit RSA key pair
const keys = forge.pki.rsa.generateKeyPair(2048);

// Create a self-signed certificate
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';

// Valid for 10 years
const now = new Date();
cert.validity.notBefore = now;
cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());

const attrs = [
  { name: 'commonName', value: 'Paralegix Document Signing' },
  { name: 'organizationName', value: 'Paralegix' },
  { name: 'countryName', value: 'US' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs); // Self-signed: issuer = subject

// Key usage extensions for document signing
cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  {
    name: 'keyUsage',
    digitalSignature: true,
    nonRepudiation: true,
  },
  {
    name: 'extKeyUsage',
    emailProtection: true,
  },
]);

// Sign the certificate with our private key (SHA-256)
cert.sign(keys.privateKey, forge.md.sha256.create());

// Export as PKCS#12 (.p12)
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSPHRASE, {
  algorithm: '3des', // Required for broad compatibility
});
const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
const p12Buffer = Buffer.from(p12Der, 'binary');

fs.writeFileSync(OUTPUT_PATH, p12Buffer);

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
