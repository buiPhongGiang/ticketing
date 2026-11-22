import React from 'react';
import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
import { iconData, type IconName } from './icon-data';

const shapes: Record<string, React.ComponentType<Record<string, string>>> = { path: Path, circle: Circle, rect: Rect, line: Line, polyline: Polyline, polygon: Polygon, ellipse: Ellipse } as never;

/**
 * One outline icon (Lucide, 24 × 24 grid, 2 px round stroke). Decorative by default: the label next to it, or the
 * button's accessibilityLabel, is what a screen reader says. `fill` paints the inside, for a selected state.
 */
export function Glyph({ name, size = 18, color, fill = 'none', strokeWidth = 2 }: { name: IconName; size?: number; color: string; fill?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      accessibilityElementsHidden importantForAccessibility="no" style={{ flexShrink: 0 }}>
      {iconData[name].map(([tag, attrs], i) => React.createElement(shapes[tag], { key: String(i), ...(attrs as Record<string, string>) }))}
    </Svg>
  );
}
