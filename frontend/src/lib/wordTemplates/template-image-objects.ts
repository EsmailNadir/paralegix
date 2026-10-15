"use client";


export const TEMPLATE_IMAGE_OBJECT_SELECTOR = "[data-template-image-object-id]";
export const TEMPLATE_IMAGE_VIEWPORT_SELECTOR = "[data-template-image-viewport]";
export const TEMPLATE_IMAGE_ELEMENT_SELECTOR = 'img[data-template-object-image="true"]';

export type TemplateImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CreateTemplateImageObjectConfig = {
  id?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  src?: string | null;
  assetId?: string | null;
  fileName?: string | null;
  intrinsicWidth: number;
  intrinsicHeight: number;
  source?: string | null;
  crop?: Partial<TemplateImageCropRect>;
};

function toNullableNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createTemplateImageObjectElement(doc: Document, config: CreateTemplateImageObjectConfig) {
  const object = doc.createElement("div");
  object.setAttribute("data-template-image-object-id", config.id ?? `image_${Math.random().toString(36).slice(2, 10)}`);
  object.setAttribute("contenteditable", "false");
  object.style.position = "absolute";
  object.style.left = `${config.left}px`;
  object.style.top = `${config.top}px`;
  object.style.width = `${config.width}px`;
  object.style.height = `${config.height}px`;
  object.style.zIndex = "0";
  object.style.overflow = "visible";
  object.style.minWidth = "24px";
  object.style.minHeight = "24px";
  object.dataset.templateImageCropX = String(config.crop?.x ?? 0);
  object.dataset.templateImageCropY = String(config.crop?.y ?? 0);
  object.dataset.templateImageCropWidth = String(config.crop?.width ?? config.intrinsicWidth);
  object.dataset.templateImageCropHeight = String(config.crop?.height ?? config.intrinsicHeight);

  const viewport = doc.createElement("div");
  viewport.setAttribute("data-template-image-viewport", "true");
  viewport.style.position = "relative";
  viewport.style.width = "100%";
  viewport.style.height = "100%";
  viewport.style.overflow = "hidden";
  viewport.style.pointerEvents = "none";
  viewport.style.borderRadius = "2px";
  viewport.style.background = "transparent";

  const img = doc.createElement("img");
  img.setAttribute("data-template-object-image", "true");
  img.setAttribute("alt", "");
  img.draggable = false;
  img.style.position = "absolute";
  img.style.maxWidth = "none";
  img.style.userSelect = "none";
  img.style.pointerEvents = "none";
  img.style.setProperty("-webkit-user-drag", "none");
  img.dataset.templateIntrinsicWidth = String(config.intrinsicWidth);
  img.dataset.templateIntrinsicHeight = String(config.intrinsicHeight);
  if (config.assetId) img.dataset.templateAssetId = config.assetId;
  if (config.fileName) img.dataset.templateFileName = config.fileName;
  if (config.source) img.dataset.templateSource = config.source;
  if (config.src) img.src = config.src;

  viewport.appendChild(img);
  object.appendChild(viewport);
  applyTemplateImageObjectLayout(object);
  return object;
}

export function getTemplateImageViewport(object: ParentNode) {
  return object.querySelector<HTMLElement>(TEMPLATE_IMAGE_VIEWPORT_SELECTOR);
}

export function getTemplateImageElement(object: ParentNode) {
  return object.querySelector<HTMLImageElement>(TEMPLATE_IMAGE_ELEMENT_SELECTOR);
}

export function getTemplateImageCropRect(object: HTMLElement): TemplateImageCropRect {
  const img = getTemplateImageElement(object);
  const intrinsicWidth = toNullableNumber(img?.dataset.templateIntrinsicWidth) ?? 1;
  const intrinsicHeight = toNullableNumber(img?.dataset.templateIntrinsicHeight) ?? 1;
  return {
    x: toNullableNumber(object.dataset.templateImageCropX) ?? 0,
    y: toNullableNumber(object.dataset.templateImageCropY) ?? 0,
    width: toNullableNumber(object.dataset.templateImageCropWidth) ?? intrinsicWidth,
    height: toNullableNumber(object.dataset.templateImageCropHeight) ?? intrinsicHeight,
  };
}

export function setTemplateImageCropRect(object: HTMLElement, crop: TemplateImageCropRect) {
  object.dataset.templateImageCropX = String(crop.x);
  object.dataset.templateImageCropY = String(crop.y);
  object.dataset.templateImageCropWidth = String(crop.width);
  object.dataset.templateImageCropHeight = String(crop.height);
  applyTemplateImageObjectLayout(object);
}

export function syncTemplateImageIntrinsicSize(object: HTMLElement) {
  const img = getTemplateImageElement(object);
  if (!img) return;

  const naturalWidth = img.naturalWidth || toNullableNumber(img.dataset.templateIntrinsicWidth) || 1;
  const naturalHeight = img.naturalHeight || toNullableNumber(img.dataset.templateIntrinsicHeight) || 1;
  img.dataset.templateIntrinsicWidth = String(naturalWidth);
  img.dataset.templateIntrinsicHeight = String(naturalHeight);

  if (!object.dataset.templateImageCropWidth) {
    object.dataset.templateImageCropWidth = String(naturalWidth);
  }
  if (!object.dataset.templateImageCropHeight) {
    object.dataset.templateImageCropHeight = String(naturalHeight);
  }
  applyTemplateImageObjectLayout(object);
}

export function applyTemplateImageObjectLayout(object: HTMLElement) {
  const viewport = getTemplateImageViewport(object);
  const img = getTemplateImageElement(object);
  if (!viewport || !img) return;

  const objectWidth = Math.max(1, Number.parseFloat(object.style.width || "0") || object.offsetWidth || 1);
  const objectHeight = Math.max(1, Number.parseFloat(object.style.height || "0") || object.offsetHeight || 1);
  const intrinsicWidth = Math.max(1, toNullableNumber(img.dataset.templateIntrinsicWidth) ?? img.naturalWidth ?? 1);
  const intrinsicHeight = Math.max(1, toNullableNumber(img.dataset.templateIntrinsicHeight) ?? img.naturalHeight ?? 1);

  const crop = getTemplateImageCropRect(object);
  const cropWidth = Math.max(1, Math.min(intrinsicWidth, crop.width));
  const cropHeight = Math.max(1, Math.min(intrinsicHeight, crop.height));
  const cropX = Math.max(0, Math.min(intrinsicWidth - cropWidth, crop.x));
  const cropY = Math.max(0, Math.min(intrinsicHeight - cropHeight, crop.y));

  object.dataset.templateImageCropX = String(cropX);
  object.dataset.templateImageCropY = String(cropY);
  object.dataset.templateImageCropWidth = String(cropWidth);
  object.dataset.templateImageCropHeight = String(cropHeight);

  const scaleX = objectWidth / cropWidth;
  const scaleY = objectHeight / cropHeight;

  viewport.style.width = "100%";
  viewport.style.height = "100%";
  img.style.left = `${-cropX * scaleX}px`;
  img.style.top = `${-cropY * scaleY}px`;
  img.style.width = `${intrinsicWidth * scaleX}px`;
  img.style.height = `${intrinsicHeight * scaleY}px`;
}

export function stripTemplateImagePreviewSources(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>(TEMPLATE_IMAGE_ELEMENT_SELECTOR).forEach((img) => {
    if (img.dataset.templateAssetId && !(img.getAttribute("src") || "").startsWith("data:")) {
      img.removeAttribute("src");
    }
  });
}

export function hydrateTemplateAssetSourcesInDocument(doc: Document, sourceMap: Record<string, string>) {
  doc.querySelectorAll<HTMLImageElement>(TEMPLATE_IMAGE_ELEMENT_SELECTOR).forEach((img) => {
    const assetId = img.dataset.templateAssetId;
    if (!assetId) return;
    const source = sourceMap[assetId];
    if (source) img.setAttribute("src", source);
  });
}

export function injectTemplateAssetSources(html: string, sourceMap: Record<string, string>) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  hydrateTemplateAssetSourcesInDocument(doc, sourceMap);
  return doc.documentElement.outerHTML;
}

