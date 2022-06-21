import { BenchmarkRow } from './BenchmarkRow';
import React from 'react';
export const BenchmarksTable = (props) => (React.createElement("div", { style: { width: 960, margin: '2em auto' } },
    React.createElement("h1", null, "TITLE"),
    React.createElement("h1", { className: "space-bottom1" },
        "MapLibre GL JS Benchmarks \u2013 ",
        props.finished ?
            React.createElement("span", null, "Finished") :
            React.createElement("span", null, "Running")),
    props.benchmarks.map((benchmark, i) => {
        return React.createElement(BenchmarkRow, Object.assign({ key: `${benchmark.name}-${i}` }, benchmark));
    })));
//# sourceMappingURL=BenchmarkTable.js.map