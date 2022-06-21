import Benchmark from '../lib/benchmark';
import fetchStyle from '../lib/fetch_style';
import TileParser from '../lib/tile_parser';
import { OverscaledTileID } from '../../src/source/tile_id';
export default class Layout extends Benchmark {
    constructor(style, tileIDs) {
        super();
        this.style = style;
        this.tileIDs = tileIDs || [
            new OverscaledTileID(12, 0, 12, 655, 1583),
            new OverscaledTileID(8, 0, 8, 40, 98),
            new OverscaledTileID(4, 0, 4, 3, 6),
            new OverscaledTileID(0, 0, 0, 0, 0)
        ];
    }
    setup() {
        return fetchStyle(this.style)
            .then((styleJSON) => {
            this.parser = new TileParser(styleJSON, 'openmaptiles');
            return this.parser.setup();
        })
            .then(() => {
            return Promise.all(this.tileIDs.map(tileID => this.parser.fetchTile(tileID)));
        })
            .then((tiles) => {
            this.tiles = tiles;
            // parse tiles once to populate glyph/icon cache
            return Promise.all(tiles.map(tile => this.parser.parseTile(tile)));
        })
            .then(() => { });
    }
    bench() {
        let promise = Promise.resolve();
        for (const tile of this.tiles) {
            promise = promise.then(() => {
                return this.parser.parseTile(tile).then(() => { });
            });
        }
        return promise;
    }
}
//# sourceMappingURL=layout.js.map