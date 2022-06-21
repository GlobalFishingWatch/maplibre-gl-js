import * as d3 from 'd3';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Axis } from './Axis';
import { formatSample, versionColor } from './util';
export const RegressionPlot = (props) => {
    const [state, setState] = useState({ width: 100 });
    const svgElement = useRef(null);
    useEffect(() => {
        setState({ width: svgElement.current.clientWidth });
    }, [state]);
    const margin = { top: 10, right: 20, bottom: 30, left: 0 };
    const width = useMemo(() => { return state.width - margin.left - margin.right; }, [state]);
    const height = 200 - margin.top - margin.bottom;
    const versions = props.versions.filter(version => version.regression);
    const x = d3.scaleLinear()
        .domain([0, d3.max(versions.map(version => d3.max(version.regression.data, d => d[0])))])
        .range([0, width])
        .nice();
    const y = d3.scaleLinear()
        .domain([0, d3.max(versions.map(version => d3.max(version.regression.data, d => d[1])))])
        .range([height, 0])
        .nice();
    const line = d3.line()
        .x(d => x(d[0]))
        .y(d => y(d[1]));
    return (React.createElement("svg", { width: "100%", height: height + margin.top + margin.bottom, style: { overflow: 'visible' }, ref: svgElement },
        React.createElement("g", { transform: `translate(${margin.left},${margin.top})` },
            React.createElement(Axis, { orientation: "bottom", scale: x, transform: `translate(0,${height})` },
                React.createElement("text", { fill: '#000', textAnchor: "end", y: -6, x: width }, "Iterations")),
            React.createElement(Axis, { orientation: "left", scale: y, ticks: 4, tickFormat: formatSample },
                React.createElement("text", { fill: '#000', textAnchor: "end", y: 6, transform: "rotate(-90)", dy: ".71em" }, "Time (ms)")),
            versions.map((v, i) => React.createElement("g", { key: i, fill: versionColor(v.name), fillOpacity: "0.7" },
                v.regression.data.map(([a, b], i) => React.createElement("circle", { key: i, r: "2", cx: x(a), cy: y(b) })),
                React.createElement("path", { stroke: versionColor(v.name), strokeWidth: 1, strokeOpacity: 0.5, d: line(v.regression.data.map(d => [
                        d[0],
                        d[0] * v.regression.slope + v.regression.intercept
                    ])) }))))));
};
//# sourceMappingURL=RegressionPlot.js.map