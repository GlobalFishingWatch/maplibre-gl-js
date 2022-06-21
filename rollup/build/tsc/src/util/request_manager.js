export class RequestManager {
    constructor(transformRequestFn) {
        this._transformRequestFn = transformRequestFn;
    }
    transformRequest(url, type) {
        if (this._transformRequestFn) {
            return this._transformRequestFn(url, type) || { url };
        }
        return { url };
    }
    normalizeSpriteURL(url, format, extension) {
        const urlObject = parseUrl(url);
        urlObject.path += `${format}${extension}`;
        return formatUrl(urlObject);
    }
    setTransformRequest(transformRequest) {
        this._transformRequestFn = transformRequest;
    }
}
const urlRe = /^(\w+):\/\/([^/?]*)(\/[^?]+)?\??(.+)?/;
function parseUrl(url) {
    const parts = url.match(urlRe);
    if (!parts) {
        throw new Error(`Unable to parse URL "${url}"`);
    }
    return {
        protocol: parts[1],
        authority: parts[2],
        path: parts[3] || '/',
        params: parts[4] ? parts[4].split('&') : []
    };
}
function formatUrl(obj) {
    const params = obj.params.length ? `?${obj.params.join('&')}` : '';
    return `${obj.protocol}://${obj.authority}${obj.path}${params}`;
}
//# sourceMappingURL=request_manager.js.map