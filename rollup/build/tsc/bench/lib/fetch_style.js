export default function fetchStyle(value) {
    return typeof value === 'string' ?
        fetch(value).then(response => response.json()) :
        Promise.resolve(value);
}
//# sourceMappingURL=fetch_style.js.map