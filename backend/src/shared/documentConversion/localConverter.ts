import { conversionError, FORMAT_MAP, getOutputFormat, type OutputFormat } from './contract';

const libre = require('libreoffice-convert');

function convertAsync(inputBuffer: Buffer, format: string, options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    libre.convertWithOptions(inputBuffer, format, undefined, options, (err: Error | null, result: Buffer) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

export async function convertLocally(inputBuffer: Buffer, outputFormat: OutputFormat | string, inputFilename: string): Promise<Buffer> {
  const format = getOutputFormat(outputFormat);
  try {
    const options: Record<string, unknown> = { fileName: inputFilename };
    if (inputFilename.toLowerCase().endsWith('.pdf')) {
      options.sofficeAdditionalArgs = ['--infilter=writer_pdf_import'];
    }
    return await convertAsync(inputBuffer, FORMAT_MAP[format].ext, options);
  } catch (error: any) {
    console.error('[document-conversion] local conversion failed:', error.message);
    throw conversionError(error);
  }
}
