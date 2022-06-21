import { uniqueId, parseCacheControl } from '../util/util';
import { deserialize as deserializeBucket } from '../data/bucket';
import '../data/feature_index';
import GeoJSONFeature from '../util/vectortile_to_geojson';
import featureFilter from '../style-spec/feature_filter';
import SymbolBucket from '../data/bucket/symbol_bucket';
import { CollisionBoxArray } from '../data/array_types';
import Texture from '../render/texture';
import browser from '../util/browser';
import toEvaluationFeature from '../data/evaluation_feature';
import EvaluationParameters from '../style/evaluation_parameters';
import { lazyLoadRTLTextPlugin } from './rtl_text_plugin';
const CLOCK_SKEW_RETRY_TIMEOUT = 30000;
/**
 * A tile object is the combination of a Coordinate, which defines
 * its place, as well as a unique ID and data tracking for its content
 *
 * @private
 */
class Tile {
    /**
     * @param {OverscaledTileID} tileID
     * @param size
     * @private
     */
    constructor(tileID, size) {
        this.tileID = tileID;
        this.uid = uniqueId();
        this.uses = 0;
        this.tileSize = size;
        this.buckets = {};
        this.expirationTime = null;
        this.queryPadding = 0;
        this.hasSymbolBuckets = false;
        this.hasRTLText = false;
        this.dependencies = {};
        // Counts the number of times a response was already expired when
        // received. We're using this to add a delay when making a new request
        // so we don't have to keep retrying immediately in case of a server
        // serving expired tiles.
        this.expiredRequestCount = 0;
        this.state = 'loading';
    }
    registerFadeDuration(duration) {
        const fadeEndTime = duration + this.timeAdded;
        if (fadeEndTime < browser.now())
            return;
        if (this.fadeEndTime && fadeEndTime < this.fadeEndTime)
            return;
        this.fadeEndTime = fadeEndTime;
    }
    wasRequested() {
        return this.state === 'errored' || this.state === 'loaded' || this.state === 'reloading';
    }
    /**
     * Given a data object with a 'buffers' property, load it into
     * this tile's elementGroups and buffers properties and set loaded
     * to true. If the data is null, like in the case of an empty
     * GeoJSON tile, no-op but still set loaded to true.
     * @param {Object} data
     * @param painter
     * @returns {undefined}
     * @private
     */
    loadVectorData(data, painter, justReloaded) {
        if (this.hasData()) {
            this.unloadVectorData();
        }
        this.state = 'loaded';
        // empty GeoJSON tile
        if (!data) {
            this.collisionBoxArray = new CollisionBoxArray();
            return;
        }
        if (data.featureIndex) {
            this.latestFeatureIndex = data.featureIndex;
            if (data.rawTileData) {
                // Only vector tiles have rawTileData, and they won't update it for
                // 'reloadTile'
                this.latestRawTileData = data.rawTileData;
                this.latestFeatureIndex.rawTileData = data.rawTileData;
            }
            else if (this.latestRawTileData) {
                // If rawTileData hasn't updated, hold onto a pointer to the last
                // one we received
                this.latestFeatureIndex.rawTileData = this.latestRawTileData;
            }
        }
        this.collisionBoxArray = data.collisionBoxArray;
        this.buckets = deserializeBucket(data.buckets, painter.style);
        this.hasSymbolBuckets = false;
        for (const id in this.buckets) {
            const bucket = this.buckets[id];
            if (bucket instanceof SymbolBucket) {
                this.hasSymbolBuckets = true;
                if (justReloaded) {
                    bucket.justReloaded = true;
                }
                else {
                    break;
                }
            }
        }
        this.hasRTLText = false;
        if (this.hasSymbolBuckets) {
            for (const id in this.buckets) {
                const bucket = this.buckets[id];
                if (bucket instanceof SymbolBucket) {
                    if (bucket.hasRTLText) {
                        this.hasRTLText = true;
                        lazyLoadRTLTextPlugin();
                        break;
                    }
                }
            }
        }
        this.queryPadding = 0;
        for (const id in this.buckets) {
            const bucket = this.buckets[id];
            this.queryPadding = Math.max(this.queryPadding, painter.style.getLayer(id).queryRadius(bucket));
        }
        if (data.imageAtlas) {
            this.imageAtlas = data.imageAtlas;
        }
        if (data.glyphAtlasImage) {
            this.glyphAtlasImage = data.glyphAtlasImage;
        }
    }
    /**
     * Release any data or WebGL resources referenced by this tile.
     * @returns {undefined}
     * @private
     */
    unloadVectorData() {
        for (const id in this.buckets) {
            this.buckets[id].destroy();
        }
        this.buckets = {};
        if (this.imageAtlasTexture) {
            this.imageAtlasTexture.destroy();
        }
        if (this.imageAtlas) {
            this.imageAtlas = null;
        }
        if (this.glyphAtlasTexture) {
            this.glyphAtlasTexture.destroy();
        }
        this.latestFeatureIndex = null;
        this.state = 'unloaded';
    }
    getBucket(layer) {
        return this.buckets[layer.id];
    }
    upload(context) {
        for (const id in this.buckets) {
            const bucket = this.buckets[id];
            if (bucket.uploadPending()) {
                bucket.upload(context);
            }
        }
        const gl = context.gl;
        if (this.imageAtlas && !this.imageAtlas.uploaded) {
            this.imageAtlasTexture = new Texture(context, this.imageAtlas.image, gl.RGBA);
            this.imageAtlas.uploaded = true;
        }
        if (this.glyphAtlasImage) {
            this.glyphAtlasTexture = new Texture(context, this.glyphAtlasImage, gl.ALPHA);
            this.glyphAtlasImage = null;
        }
    }
    prepare(imageManager) {
        if (this.imageAtlas) {
            this.imageAtlas.patchUpdatedImages(imageManager, this.imageAtlasTexture);
        }
    }
    // Queries non-symbol features rendered for this tile.
    // Symbol features are queried globally
    queryRenderedFeatures(layers, serializedLayers, sourceFeatureState, queryGeometry, cameraQueryGeometry, scale, params, transform, maxPitchScaleFactor, pixelPosMatrix) {
        if (!this.latestFeatureIndex || !this.latestFeatureIndex.rawTileData)
            return {};
        return this.latestFeatureIndex.query({
            queryGeometry,
            cameraQueryGeometry,
            scale,
            tileSize: this.tileSize,
            pixelPosMatrix,
            transform,
            params,
            queryPadding: this.queryPadding * maxPitchScaleFactor
        }, layers, serializedLayers, sourceFeatureState);
    }
    querySourceFeatures(result, params) {
        const featureIndex = this.latestFeatureIndex;
        if (!featureIndex || !featureIndex.rawTileData)
            return;
        const vtLayers = featureIndex.loadVTLayers();
        const sourceLayer = params ? params.sourceLayer : '';
        const layer = vtLayers._geojsonTileLayer || vtLayers[sourceLayer];
        if (!layer)
            return;
        const filter = featureFilter(params && params.filter);
        const { z, x, y } = this.tileID.canonical;
        const coord = { z, x, y };
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            if (filter.needGeometry) {
                const evaluationFeature = toEvaluationFeature(feature, true);
                if (!filter.filter(new EvaluationParameters(this.tileID.overscaledZ), evaluationFeature, this.tileID.canonical))
                    continue;
            }
            else if (!filter.filter(new EvaluationParameters(this.tileID.overscaledZ), feature)) {
                continue;
            }
            const id = featureIndex.getId(feature, sourceLayer);
            const geojsonFeature = new GeoJSONFeature(feature, z, x, y, id);
            geojsonFeature.tile = coord;
            result.push(geojsonFeature);
        }
    }
    hasData() {
        return this.state === 'loaded' || this.state === 'reloading' || this.state === 'expired';
    }
    patternsLoaded() {
        return this.imageAtlas && !!Object.keys(this.imageAtlas.patternPositions).length;
    }
    setExpiryData(data) {
        const prior = this.expirationTime;
        if (data.cacheControl) {
            const parsedCC = parseCacheControl(data.cacheControl);
            if (parsedCC['max-age'])
                this.expirationTime = Date.now() + parsedCC['max-age'] * 1000;
        }
        else if (data.expires) {
            this.expirationTime = new Date(data.expires).getTime();
        }
        if (this.expirationTime) {
            const now = Date.now();
            let isExpired = false;
            if (this.expirationTime > now) {
                isExpired = false;
            }
            else if (!prior) {
                isExpired = true;
            }
            else if (this.expirationTime < prior) {
                // Expiring date is going backwards:
                // fall back to exponential backoff
                isExpired = true;
            }
            else {
                const delta = this.expirationTime - prior;
                if (!delta) {
                    // Server is serving the same expired resource over and over: fall
                    // back to exponential backoff.
                    isExpired = true;
                }
                else {
                    // Assume that either the client or the server clock is wrong and
                    // try to interpolate a valid expiration date (from the client POV)
                    // observing a minimum timeout.
                    this.expirationTime = now + Math.max(delta, CLOCK_SKEW_RETRY_TIMEOUT);
                }
            }
            if (isExpired) {
                this.expiredRequestCount++;
                this.state = 'expired';
            }
            else {
                this.expiredRequestCount = 0;
            }
        }
    }
    getExpiryTimeout() {
        if (this.expirationTime) {
            if (this.expiredRequestCount) {
                return 1000 * (1 << Math.min(this.expiredRequestCount - 1, 31));
            }
            else {
                // Max value for `setTimeout` implementations is a 32 bit integer; cap this accordingly
                return Math.min(this.expirationTime - new Date().getTime(), Math.pow(2, 31) - 1);
            }
        }
    }
    setFeatureState(states, painter) {
        if (!this.latestFeatureIndex ||
            !this.latestFeatureIndex.rawTileData ||
            Object.keys(states).length === 0) {
            return;
        }
        const vtLayers = this.latestFeatureIndex.loadVTLayers();
        for (const id in this.buckets) {
            if (!painter.style.hasLayer(id))
                continue;
            const bucket = this.buckets[id];
            // Buckets are grouped by common source-layer
            const sourceLayerId = bucket.layers[0]['sourceLayer'] || '_geojsonTileLayer';
            const sourceLayer = vtLayers[sourceLayerId];
            const sourceLayerStates = states[sourceLayerId];
            if (!sourceLayer || !sourceLayerStates || Object.keys(sourceLayerStates).length === 0)
                continue;
            bucket.update(sourceLayerStates, sourceLayer, this.imageAtlas && this.imageAtlas.patternPositions || {});
            const layer = painter && painter.style && painter.style.getLayer(id);
            if (layer) {
                this.queryPadding = Math.max(this.queryPadding, layer.queryRadius(bucket));
            }
        }
    }
    holdingForFade() {
        return this.symbolFadeHoldUntil !== undefined;
    }
    symbolFadeFinished() {
        return !this.symbolFadeHoldUntil || this.symbolFadeHoldUntil < browser.now();
    }
    clearFadeHold() {
        this.symbolFadeHoldUntil = undefined;
    }
    setHoldDuration(duration) {
        this.symbolFadeHoldUntil = browser.now() + duration;
    }
    setDependencies(namespace, dependencies) {
        const index = {};
        for (const dep of dependencies) {
            index[dep] = true;
        }
        this.dependencies[namespace] = index;
    }
    hasDependency(namespaces, keys) {
        for (const namespace of namespaces) {
            const dependencies = this.dependencies[namespace];
            if (dependencies) {
                for (const key of keys) {
                    if (dependencies[key]) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
export default Tile;
//# sourceMappingURL=tile.js.map