import React from 'react';
function identity(x) {
    return x;
}
function translateX(x) {
    return `translate(${x + 0.5},0)`;
}
function translateY(y) {
    return `translate(0,${y + 0.5})`;
}
function number(scale) {
    return function (d) {
        return +scale(d);
    };
}
function center(scale) {
    let offset = Math.max(0, scale.bandwidth() - 1) / 2; // Adjust for 0.5px offset.
    if (scale.round())
        offset = Math.round(offset);
    return function (d) {
        return +scale(d) + offset;
    };
}
export const Axis = (props) => {
    const scale = props.scale;
    const orient = props.orientation || 'left';
    const tickArguments = props.ticks ? [].concat(props.ticks) : [];
    const tickValues = props.tickValues || null;
    const tickFormat = props.tickFormat || null;
    const tickSizeInner = props.tickSize || props.tickSizeInner || 6;
    const tickSizeOuter = props.tickSize || props.tickSizeOuter || 6;
    const tickPadding = props.tickPadding || 3;
    const k = orient === 'top' || orient === 'left' ? -1 : 1;
    const x = orient === 'left' || orient === 'right' ? 'x' : 'y';
    const transform = orient === 'top' || orient === 'bottom' ? translateX : translateY;
    const values = tickValues == null ? (scale.ticks ?
        scale.ticks(...tickArguments) :
        scale.domain()) : tickValues;
    const format = tickFormat == null ? (scale.tickFormat ?
        scale.tickFormat(...tickArguments) :
        identity) : tickFormat;
    const spacing = Math.max(tickSizeInner, 0) + tickPadding;
    const range = scale.range();
    const range0 = +range[0] + 0.5;
    const range1 = +range[range.length - 1] + 0.5;
    const position = (scale.bandwidth ? center : number)(scale.copy());
    return (React.createElement("g", { fill: 'none', fontSize: 10, fontFamily: 'sans-serif', textAnchor: orient === 'right' ? 'start' : orient === 'left' ? 'end' : 'middle', transform: props.transform },
        React.createElement("path", { className: 'domain', stroke: '#000', d: orient === 'left' || orient === 'right' ?
                `M${k * tickSizeOuter},${range0}H0.5V${range1}H${k * tickSizeOuter}` :
                `M${range0},${k * tickSizeOuter}V0.5H${range1}V${k * tickSizeOuter}` }),
        values.map((d, i) => React.createElement("g", { key: i, className: 'tick', transform: transform(position(d)) },
            React.createElement("line", Object.assign({ stroke: '#000' }, { [`${x}2`]: k * tickSizeInner })),
            React.createElement("text", Object.assign({ fill: '#000', dy: orient === 'top' ? '0em' : orient === 'bottom' ? '0.71em' : '0.32em' }, { [x]: k * spacing }), format(d)))),
        props.children));
};
//# sourceMappingURL=Axis.js.map