import { StepFailed } from './client';
import type { StressConfig } from './config';
import { coreSession } from './scenarios/core';
import { convertDocxForSigning, signingRoundTrip } from './scenarios/esign';
import { ensureTemplates, exportHtmlPdf, fillDocxToPdf } from './scenarios/templates';
import { sleep, think, type Vu } from './vu';

export interface Fixtures {
  pdf: Buffer;
  docx: Buffer;
}

/** Runs one flow; a StepFailed is recorded and the user carries on, anything else aborts the run. */
async function attempt(failures: string[], flow: () => Promise<void>): Promise<void> {
  try {
    await flow();
  } catch (err) {
    if (err instanceof StepFailed) failures.push(err.message);
    else throw err;
  }
}

/**
 * Ten people working normally: mostly everyday screens, with a document sent
 * for signature or generated from a template now and then. Users arrive one a
 * second, and a flow already under way finishes after the deadline passes.
 */
export async function runRealistic(vus: Vu[], config: StressConfig, fixtures: Fixtures, failures: string[]): Promise<void> {
  const deadline = Date.now() + config.durationSec * 1000;
  await Promise.all(vus.map(async (vu, i) => {
    await sleep(i * 1000);
    await attempt(failures, () => ensureTemplates(vu, fixtures.docx));
    while (Date.now() < deadline) {
      const roll = Math.random();
      if (roll < 0.65) await attempt(failures, () => coreSession(vu));
      else if (roll < 0.80) await attempt(failures, () => signingRoundTrip(vu, fixtures.pdf));
      else if (roll < 0.85) await attempt(failures, () => convertDocxForSigning(vu, fixtures.docx));
      else if (roll < 0.95) await attempt(failures, () => fillDocxToPdf(vu));
      else await attempt(failures, () => exportHtmlPdf(vu));
      await think();
    }
  }));
}

/**
 * Every user hits the same document operation at the same instant, one
 * operation type per wave, so each wave measures one path through the document
 * worker: LibreOffice conversion, Chromium rendering, then signing.
 */
export async function runDocsBurst(vus: Vu[], config: StressConfig, fixtures: Fixtures, failures: string[]): Promise<void> {
  await Promise.all(vus.map((vu) => attempt(failures, () => ensureTemplates(vu, fixtures.docx))));
  const wave = (flow: (vu: Vu) => Promise<void>) => Promise.all(vus.map((vu) => attempt(failures, () => flow(vu))));
  for (let round = 1; round <= config.burstRounds; round += 1) {
    console.log(`  round ${round}/${config.burstRounds}`);
    await wave(fillDocxToPdf);
    await wave((vu) => convertDocxForSigning(vu, fixtures.docx));
    await wave(exportHtmlPdf);
    await wave((vu) => signingRoundTrip(vu, fixtures.pdf));
  }
}
