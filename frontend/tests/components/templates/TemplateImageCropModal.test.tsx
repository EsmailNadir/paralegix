/**
 * `TemplateImageCropModal`'s close path.
 *
 * What has to break for this to go red: a second Escape handler beside the
 * one `Modal` already installs, which closes the cropper twice per keypress
 * and ignores whether another dialog sits above it.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import TemplateImageCropModal from "@/components/templatesComp/TemplateImageCropModal";

it("calls onClose once per Escape", () => {
  const onClose = jest.fn();
  render(
    <TemplateImageCropModal
      isOpen
      imageSrc="data:image/png;base64,AAAA"
      imageName="logo.png"
      initialCrop={null}
      onClose={onClose}
      onConfirm={jest.fn()}
    />
  );
  expect(screen.getByRole("dialog", { name: "Crop Image" })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
});
