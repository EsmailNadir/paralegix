function clampPositive(value: any, fallback: any) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function fitImageRect({ boundsX, boundsY, boundsWidth, boundsHeight, imageAspectRatio }: any) {
  const safeWidth = clampPositive(boundsWidth, 1);
  const safeHeight = clampPositive(boundsHeight, 1);
  const safeAspect = clampPositive(imageAspectRatio, 3);
  const boundsAspect = safeWidth / safeHeight;

  let width = safeWidth;
  let height = width / safeAspect;

  if (safeAspect <= boundsAspect) {
    height = safeHeight;
    width = height * safeAspect;
  }

  return {
    x: boundsX + (safeWidth - width) / 2,
    y: boundsY + (safeHeight - height) / 2,
    width,
    height,
  };
}

export function calculateStandardSignatureLayout({ boxWidth, boxHeight, imageAspectRatio }: any) {
  const safeBoxWidth = clampPositive(boxWidth, 1);
  const safeBoxHeight = clampPositive(boxHeight, 1);
  const maxWidth = safeBoxWidth * 0.72;
  const maxHeight = safeBoxHeight * 0.68;

  return {
    style: 'standard',
    imageRect: fitImageRect({
      boundsX: (safeBoxWidth - maxWidth) / 2,
      boundsY: (safeBoxHeight - maxHeight) / 2,
      boundsWidth: maxWidth,
      boundsHeight: maxHeight,
      imageAspectRatio,
    }),
  };
}

export function calculateXLineSignatureLayout({ boxWidth, boxHeight, imageAspectRatio }: any) {
  const safeBoxWidth = clampPositive(boxWidth, 1);
  const safeBoxHeight = clampPositive(boxHeight, 1);
  const safeAspect = clampPositive(imageAspectRatio, 3);
  const xFontSize = Math.max(10, Math.min(16, safeBoxHeight * 0.35));
  const xMarkX = Math.max(2, Math.min(6, safeBoxWidth * 0.02));
  const lineStartX = xMarkX + xFontSize * 0.9 + Math.max(4, safeBoxWidth * 0.02);
  const lineEndX = safeBoxWidth;
  const lineY = safeBoxHeight * 0.88;
  const lineThickness = Math.max(1, safeBoxHeight * 0.025);
  const imagePaddingX = Math.max(safeBoxWidth * 0.02, 4);

  // Fit the signature inside the field box, resting on the line. It fills as much
  // of the box (width up to the line, height up to just above the line) as its
  // aspect ratio allows without spilling outside the box, so it matches the
  // field size instead of shrinking to a sliver or ballooning above the line.
  const topMargin = safeBoxHeight * 0.05;
  const baselineGap = Math.max(safeBoxHeight * 0.04, 1.5);
  const availableWidth = Math.max(lineEndX - lineStartX - imagePaddingX * 2, safeBoxWidth * 0.2);
  const availableHeight = Math.max(lineY - baselineGap - topMargin, safeBoxHeight * 0.2);
  let imageWidth = availableWidth;
  let imageHeight = imageWidth / safeAspect;
  if (imageHeight > availableHeight) {
    imageHeight = availableHeight;
    imageWidth = imageHeight * safeAspect;
  }
  const imageBottom = lineY - baselineGap;

  return {
    style: 'x-line',
    imageRect: {
      x: lineStartX + imagePaddingX + (availableWidth - imageWidth) / 2,
      y: imageBottom - imageHeight,
      width: imageWidth,
      height: imageHeight,
    },
    line: {
      x: lineStartX,
      y: lineY,
      width: Math.max(lineEndX - lineStartX, 1),
      thickness: lineThickness,
    },
    xMark: {
      x: xMarkX,
      y: Math.max(lineY - xFontSize * 0.9, 0),
      fontSize: xFontSize,
    },
  };
}

export function calculateSignatureLayout({ boxWidth, boxHeight, imageAspectRatio, style }: any) {
  return style === 'x-line'
    ? calculateXLineSignatureLayout({ boxWidth, boxHeight, imageAspectRatio })
    : calculateStandardSignatureLayout({ boxWidth, boxHeight, imageAspectRatio });
}
