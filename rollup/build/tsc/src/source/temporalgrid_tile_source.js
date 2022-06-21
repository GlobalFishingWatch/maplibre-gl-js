import VectorTileSource from './vector_tile_source';
class TemporalGridVectorTileSource extends VectorTileSource {
    // type: 'temporalgrid'; pending to extend VectorTileSource to allow overrriding
    constructor(id, options, dispatcher, eventedParent) {
        console.log('LALALAL');
        super(id, options, dispatcher, eventedParent);
        this.type = 'temporalgrid';
    }
}
export default TemporalGridVectorTileSource;
//# sourceMappingURL=temporalgrid_tile_source.js.map