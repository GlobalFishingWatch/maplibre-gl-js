export function renderStyleImage(image) {
    const { userImage } = image;
    if (userImage && userImage.render) {
        const updated = userImage.render();
        if (updated) {
            image.data.replace(new Uint8Array(userImage.data.buffer));
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=style_image.js.map