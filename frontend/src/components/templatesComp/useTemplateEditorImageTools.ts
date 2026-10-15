import { useCallback, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { TemplateAsset } from '@/types/template';
import { applyTemplateImageObjectLayout } from './templateImageObjects';
import { closeTemplateImageLayerMenus, syncTemplateImageLayerMenuState, applyTemplateImageZOrderForEditor, moveImageToStackIndex, moveImageInStack, sortTemplateImagesOnPage } from './templateEditorDom';

interface TemplateImageToolsOptions {
  editorRef: RefObject<HTMLDivElement | null>;
  textBoxModeRef: RefObject<boolean>;
  textBoxDragActiveRef: RefObject<boolean>;
  zoomLevelRef: RefObject<number>;
  suppressNextTextBoxClickRef: RefObject<boolean>;
  flushSnapshot: () => void;
  getPageAtClientPoint: (x: number, y: number) => HTMLElement | null;
  hydrateImageObjectSrc: (object: HTMLElement) => void;
  scheduleSnapshot: () => void;
  selectImageObject: (object: HTMLElement) => void;
  templateAssets: TemplateAsset[];
  setImageLayerTick: Dispatch<SetStateAction<number>>;
  setSelectedImageObjectId: Dispatch<SetStateAction<string | null>>;
  setCropTargetImageId: Dispatch<SetStateAction<string | null>>;
}

/** Wire image drag, resize, crop, layer and delete tools into the authoring DOM. */
export function useTemplateEditorImageTools({ editorRef, textBoxModeRef, textBoxDragActiveRef, zoomLevelRef, suppressNextTextBoxClickRef, flushSnapshot, getPageAtClientPoint, hydrateImageObjectSrc, scheduleSnapshot, selectImageObject, templateAssets, setImageLayerTick, setSelectedImageObjectId, setCropTargetImageId }: TemplateImageToolsOptions) {
  const hydrateImageObject = useCallback((object: HTMLElement) => {
    if (object.dataset.templateImageHydrated === "true") {
      object.querySelectorAll("[data-template-image-drag]").forEach((el) => el.remove());
      syncTemplateImageLayerMenuState(object);
      hydrateImageObjectSrc(object);
      return;
    }

    object.dataset.templateImageHydrated = "true";
    object.setAttribute("contenteditable", "false");
    object.style.position = "absolute";
    object.style.overflow = "visible";
    object.style.minWidth = "24px";
    object.style.minHeight = "24px";
    object.style.cursor = "grab";

    hydrateImageObjectSrc(object);

    const ensureControl = (selector: string, creator: () => HTMLElement) => {
      let control = object.querySelector<HTMLElement>(selector);
      if (!control) {
        control = creator();
        object.appendChild(control);
      }
      control.setAttribute("data-template-image-control", "true");
      control.style.display = "none";
      return control;
    };

    const cropButton = ensureControl('[data-template-image-crop]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-crop", "true");
      button.textContent = "Crop";
      button.style.cssText = "position:absolute;top:-28px;right:54px;height:22px;padding:0 8px;border:none;border-radius:999px;background:#0284c7;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const layerButton = ensureControl('[data-template-image-layer-trigger]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-layer-trigger", "true");
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.textContent = "Layer";
      button.style.cssText = "position:absolute;top:-28px;right:108px;height:22px;padding:0 10px;border:none;border-radius:999px;background:#0f172a;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const deleteButton = ensureControl('[data-template-image-delete]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-delete", "true");
      button.textContent = "Delete";
      button.style.cssText = "position:absolute;top:-28px;right:0;height:22px;padding:0 8px;border:none;border-radius:999px;background:#dc2626;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const resizeHandle = ensureControl('[data-template-image-resize]', () => {
      const handle = document.createElement("div");
      handle.setAttribute("data-template-image-resize", "true");
      handle.style.cssText = "position:absolute;right:-8px;bottom:-8px;width:16px;height:16px;border-radius:4px;background:#0ea5e9;border:2px solid #fff;box-shadow:0 4px 12px rgba(14,165,233,0.35);cursor:se-resize;z-index:2;touch-action:none;";
      return handle;
    });

    let layerMenu = object.querySelector<HTMLElement>("[data-template-image-layer-menu]");
    if (!layerMenu) {
      layerMenu = document.createElement("div");
      layerMenu.setAttribute("data-template-image-layer-menu", "true");
      layerMenu.setAttribute("role", "menu");
      layerMenu.style.cssText = "position:absolute;top:0;right:108px;display:none;min-width:158px;flex-direction:column;gap:2px;padding:6px;border:1px solid rgba(15,23,42,0.12);border-radius:10px;background:rgba(255,255,255,0.98);box-shadow:0 18px 40px rgba(15,23,42,0.18);backdrop-filter:blur(8px);z-index:24;";

      const createLayerActionButton = (action: string, label: string) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("data-template-image-layer-action", action);
        button.setAttribute("role", "menuitem");
        button.textContent = label;
        button.style.cssText = "display:flex;align-items:center;justify-content:flex-start;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:#0f172a;font-size:12px;font-weight:600;cursor:pointer;text-align:left;";
        button.addEventListener("mouseenter", () => {
          if (!button.disabled) button.style.background = "rgba(14,165,233,0.12)";
        });
        button.addEventListener("mouseleave", () => {
          button.style.background = "transparent";
        });
        layerMenu?.appendChild(button);
        return button;
      };

      createLayerActionButton("all-back", "All the way back");
      createLayerActionButton("back-one", "Back one");
      createLayerActionButton("up-one", "Up one");
      createLayerActionButton("all-up", "All the way up");

      const menuSeparator = document.createElement("div");
      menuSeparator.style.cssText = "height:1px;background:rgba(15,23,42,0.1);margin:4px 2px;";
      layerMenu.appendChild(menuSeparator);
      createLayerActionButton("pin-background", "Pin as background");
      object.appendChild(layerMenu);
    }

    const hideLayerMenu = () => {
      layerMenu.style.display = "none";
      layerButton.setAttribute("aria-expanded", "false");
    };

    const showLayerMenu = () => {
      const editor = editorRef.current;
      if (editor) closeTemplateImageLayerMenus(editor);
      syncTemplateImageLayerMenuState(object);
      layerMenu.style.display = "flex";
      layerButton.setAttribute("aria-expanded", "true");
    };

    const runLayerAction = (mutate: (page: HTMLElement, imageObject: HTMLElement) => boolean) => {
      const editor = editorRef.current;
      const page = object.closest<HTMLElement>(".pdf-page");
      if (!editor || !page) return;
      selectImageObject(object);
      if (!mutate(page, object)) return;
      hideLayerMenu();
      closeTemplateImageLayerMenus(editor);
      flushSnapshot();
      applyTemplateImageZOrderForEditor(editor);
      syncTemplateImageLayerMenuState(object);
      scheduleSnapshot();
      setImageLayerTick((tick) => tick + 1);
    };

    object.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (textBoxModeRef.current) return;
      const t = event.target;
      if (t instanceof Element && t.closest("[data-template-image-crop], [data-template-image-delete], [data-template-image-resize], [data-template-image-layer-trigger], [data-template-image-layer-menu]")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectImageObject(object);
      hideLayerMenu();
      textBoxDragActiveRef.current = true;
      let didMove = false;
      let currentPage = object.closest<HTMLElement>(".pdf-page");
      if (!currentPage) {
        textBoxDragActiveRef.current = false;
        return;
      }

      const currentZoom = Math.max(zoomLevelRef.current, 0.01);
      const objectRect = object.getBoundingClientRect();
      const offsetX = (event.clientX - objectRect.left) / currentZoom;
      const offsetY = (event.clientY - objectRect.top) / currentZoom;
      const previousBodyCursor = document.body.style.cursor;
      document.body.style.cursor = "grabbing";

      const onMove = (moveEvent: MouseEvent) => {
        didMove = true;
        const hoveredPage = getPageAtClientPoint(moveEvent.clientX, moveEvent.clientY);
        if (hoveredPage && hoveredPage !== currentPage) {
          hoveredPage.appendChild(object);
          currentPage = hoveredPage;
        }

        if (!currentPage) return;
        const liveRect = object.getBoundingClientRect();
        const pageRect = currentPage.getBoundingClientRect();
        const zoom = Math.max(zoomLevelRef.current, 0.01);
        const pageWidth = pageRect.width / zoom;
        const pageHeight = pageRect.height / zoom;
        const objectWidth = liveRect.width / zoom;
        const objectHeight = liveRect.height / zoom;
        const pointerX = (moveEvent.clientX - pageRect.left) / zoom;
        const pointerY = (moveEvent.clientY - pageRect.top) / zoom;
        // Allow partial off-page placement so users can intentionally crop by viewport.
        // Keep a small sliver visible to avoid losing the image completely.
        const minVisible = 24;
        const minLeft = -objectWidth + minVisible;
        const maxLeft = pageWidth - minVisible;
        const minTop = -objectHeight + minVisible;
        const maxTop = pageHeight - minVisible;
        const nextLeft = Math.max(minLeft, Math.min(maxLeft, pointerX - offsetX));
        const nextTop = Math.max(minTop, Math.min(maxTop, pointerY - offsetY));
        object.style.left = `${nextLeft}px`;
        object.style.top = `${nextTop}px`;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        document.body.style.cursor = previousBodyCursor;
        if (didMove) {
          scheduleSnapshot();
          suppressNextTextBoxClickRef.current = true;
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        selectImageObject(object);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    deleteButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      const objectId = object.getAttribute("data-template-image-object-id");
      setSelectedImageObjectId((current) => current === objectId ? null : current);
      object.remove();
      const ed = editorRef.current;
      if (ed) applyTemplateImageZOrderForEditor(ed);
      scheduleSnapshot();
      setImageLayerTick((t) => t + 1);
    });

    cropButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      selectImageObject(object);
      setCropTargetImageId(object.getAttribute("data-template-image-object-id"));
    });

    layerButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectImageObject(object);
      if (layerMenu.style.display === "flex") {
        hideLayerMenu();
      } else {
        showLayerMenu();
      }
    });

    const layerActions: Array<{
      selector: string;
      handler: () => void;
    }> = [
      {
        selector: '[data-template-image-layer-action="all-back"]',
        handler: () => runLayerAction((page, imageObject) => moveImageToStackIndex(page, imageObject, 0)),
      },
      {
        selector: '[data-template-image-layer-action="back-one"]',
        handler: () => runLayerAction((page, imageObject) => moveImageInStack(page, imageObject, -1)),
      },
      {
        selector: '[data-template-image-layer-action="up-one"]',
        handler: () => runLayerAction((page, imageObject) => moveImageInStack(page, imageObject, 1)),
      },
      {
        selector: '[data-template-image-layer-action="all-up"]',
        handler: () => runLayerAction((page, imageObject) => {
          const totalImages = sortTemplateImagesOnPage(page).length;
          return moveImageToStackIndex(page, imageObject, totalImages - 1);
        }),
      },
    ];

    layerActions.forEach(({ selector, handler }) => {
      const button = layerMenu.querySelector<HTMLButtonElement>(selector);
      button?.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        hideLayerMenu();
        selectImageObject(object);
        handler();
      });
    });

    // Pin-as-background toggle, separate from layer stack actions
    const pinActionButton = layerMenu.querySelector<HTMLButtonElement>('[data-template-image-layer-action="pin-background"]');
    pinActionButton?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      const isPinned = object.dataset.templateImagePinned === "true";
      if (isPinned) {
        delete object.dataset.templateImagePinned;
      } else {
        object.dataset.templateImagePinned = "true";
      }
      scheduleSnapshot();
    });

    resizeHandle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      selectImageObject(object);
      textBoxDragActiveRef.current = true;

      const zoom = Math.max(zoomLevelRef.current, 0.01);
      const startRect = object.getBoundingClientRect();
      const startWidth = startRect.width / zoom;
      const startHeight = startRect.height / zoom;
      const startX = event.clientX;
      const startY = event.clientY;
      const page = object.closest<HTMLElement>(".pdf-page");
      const pageRect = page?.getBoundingClientRect() ?? null;
      const objectLeft = Number.parseFloat(object.style.left || "0");
      const objectTop = Number.parseFloat(object.style.top || "0");
      let didResize = false;
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "se-resize";

      const onMove = (moveEvent: MouseEvent) => {
        const liveZoom = Math.max(zoomLevelRef.current, 0.01);
        const maxWidth = pageRect ? Math.max(24, pageRect.width / liveZoom - objectLeft) : Number.POSITIVE_INFINITY;
        const maxHeight = pageRect ? Math.max(24, pageRect.height / liveZoom - objectTop) : Number.POSITIVE_INFINITY;
        const nextWidth = Math.min(maxWidth, Math.max(24, startWidth + (moveEvent.clientX - startX) / liveZoom));
        const nextHeight = Math.min(maxHeight, Math.max(24, startHeight + (moveEvent.clientY - startY) / liveZoom));
        object.style.width = `${nextWidth}px`;
        object.style.height = `${nextHeight}px`;
        applyTemplateImageObjectLayout(object);
        didResize = true;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        if (didResize) {
          scheduleSnapshot();
          suppressNextTextBoxClickRef.current = true;
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    syncTemplateImageLayerMenuState(object);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- templateAssets is an invalidation key: the handlers wired up above resolve asset sources lazily, so they must be rebound when the asset list changes
  }, [flushSnapshot, getPageAtClientPoint, hydrateImageObjectSrc, scheduleSnapshot, selectImageObject, templateAssets]);

  return { hydrateImageObject };
}
