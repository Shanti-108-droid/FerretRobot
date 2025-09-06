import React from "react";

type PollockProps = {
  density?: number;
  opacityRange?: [number, number];
  strokeRange?: [number, number];
  colors?: string[];
  className?: string;
};

export function ArtPollock({
  density = 80,
  opacityRange = [0.1, 0.2],
  strokeRange = [1, 2],
  colors = ["#E8D5FF", "#C7F2F0", "#FFE2B8", "#FFD6E0", "#DDE8FF"],
  className = "absolute inset-0 w-full h-full -z-10",
}: PollockProps) {
  const lines = [];

  for (let i = 0; i < density; i++) {
    const x1 = Math.random() * 100;
    const y1 = Math.random() * 100;
    const x2 = Math.random() * 100;
    const y2 = Math.random() * 100;

    const opacity =
      Math.random() * (opacityRange[1] - opacityRange[0]) + opacityRange[0];
    const strokeWidth =
      Math.random() * (strokeRange[1] - strokeRange[0]) + strokeRange[0];
    const color = colors[Math.floor(Math.random() * colors.length)];

    lines.push(
      <line
        key={i}
        x1={`${x1}%`}
        y1={`${y1}%`}
        x2={`${x2}%`}
        y2={`${y2}%`}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={opacity}
      />
    );
  }

  return (
    <svg
      aria-hidden
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="none"
    >
      {lines}
    </svg>
  );
}
