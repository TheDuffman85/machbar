import { useId, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

const LEAVES_PER_BRANCH = 6;
const PETALS_PER_FLOWER = 6;
const FLOWERS_PER_BRANCH = 3;
const LEVELS_PER_BRANCH = LEAVES_PER_BRANCH + PETALS_PER_FLOWER * FLOWERS_PER_BRANCH;
const branchPositions = [
  { x: 0, y: 0 },
  { x: -56, y: -6 },
  { x: 56, y: -10 },
  { x: -35, y: -65 },
  { x: 35, y: -62 },
  { x: -98, y: -40 },
  { x: 98, y: -36 },
  { x: 0, y: -102 },
];
const leafPositions = [
  { x: 0, y: -26, side: -1, angle: -12 },
  { x: 0, y: -34, side: 1, angle: 12 },
  { x: -32, y: -47, side: -1, angle: -10 },
  { x: -39, y: -64, side: 1, angle: -25 },
  { x: 32, y: -49, side: 1, angle: 10 },
  { x: 39, y: -68, side: -1, angle: 25 },
];
const flowerPositions = [
  { x: 0, y: -106 },
  { x: -44, y: -78 },
  { x: 44, y: -82 },
];

function branchPosition(index: number) {
  if (index < branchPositions.length) return branchPositions[index];
  // Keep later growth spreading around the crown instead of forming a tall column.
  const angle = index * 2.39996;
  const radius = 34 * Math.sqrt(index);
  return { x: Math.cos(angle) * radius, y: -45 + Math.sin(angle) * radius * 0.65 };
}

/** Each new branch earns six leaves, then petals for three blossoms. */
export function SproutArt({ level = 2 }: { level?: number }) {
  const { t } = useTranslation();
  const titleId = useId();
  const plantLevel = Math.max(1, Math.floor(level));
  const branches = Array.from({ length: Math.ceil(plantLevel / LEVELS_PER_BRANCH) }, (_, index) => {
    const earned = Math.min(LEVELS_PER_BRANCH, plantLevel - index * LEVELS_PER_BRANCH);
    return {
      ...branchPosition(index),
      leaves: Math.min(LEAVES_PER_BRANCH, earned),
      petals: Math.max(0, earned - LEAVES_PER_BRANCH),
    };
  });
  const leaves = branches.reduce((total, branch) => total + branch.leaves, 0);
  const petals = branches.reduce((total, branch) => total + branch.petals, 0);
  const canopyHeight = Math.max(
    ...branches.map((branch) => (branch.petals ? 131 : branch.leaves > 2 ? 120 : 80) - branch.y),
  );
  const canopyRadius = Math.max(
    ...branches.map(
      (branch) => Math.abs(branch.x) + (branch.petals || branch.leaves > 2 ? 85 : 48),
    ),
  );
  // Fit a broad, rounded crown with uniform zoom so leaves and petals retain their shape.
  const scale = Math.min(1, 174 / (64 + canopyHeight), 174 / (2 * canopyRadius));
  const growthStyle = (earnedLevel: number): CSSProperties => ({
    animationDelay: `${Math.min((earnedLevel - 1) * 55, 550)}ms`,
  });

  return (
    <svg
      className="sprout-art"
      viewBox="0 0 240 210"
      role="img"
      aria-labelledby={titleId}
      data-level={plantLevel}
    >
      <title id={titleId}>{t('plantDescription', { level: plantLevel, leaves, petals })}</title>
      <circle cx="125" cy="100" r="83" fill="#dfe9d8" opacity=".6" />
      <g
        className="plant-growth"
        transform={`translate(125 184) scale(${scale}) translate(-125 -184)`}
      >
        <ellipse cx="127" cy="184" rx="68" ry="10" fill="currentColor" opacity=".07" />
        <g className="plant-canopy" transform="translate(125 120)">
          {branches.map((branch, index) => {
            const tip = branch.petals ? -106 : branch.leaves > 2 ? -70 : -38;
            return (
              <g key={index}>
                <path
                  className="plant-stem"
                  d={`M0 0 Q${branch.x * 0.5} ${branch.y + 12} ${branch.x} ${branch.y - 18} V${branch.y + tip}`}
                  stroke="#527866"
                  strokeWidth="5"
                  strokeLinecap="round"
                  fill="none"
                  pathLength="1"
                />
                <g transform={`translate(${branch.x} ${branch.y})`}>
                  {branch.leaves > 2 && (
                    <path
                      className="plant-stem"
                      d="M0 -24 Q-36 -33 -44 -78"
                      stroke="#527866"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      fill="none"
                      pathLength="1"
                    />
                  )}
                  {branch.leaves > 4 && (
                    <path
                      className="plant-stem"
                      d="M0 -26 Q36 -35 44 -82"
                      stroke="#527866"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      fill="none"
                      pathLength="1"
                    />
                  )}
                </g>
              </g>
            );
          })}
          {branches.map((branch, branchIndex) => (
            <g
              key={branchIndex}
              className="plant-branch"
              transform={`translate(${branch.x} ${branch.y})`}
            >
              {leafPositions.slice(0, branch.leaves).map(({ x, y, side, angle }, index) => (
                <g key={index} transform={`translate(${x} ${y}) rotate(${angle}) scale(${side} 1)`}>
                  <g
                    className="plant-leaf"
                    style={growthStyle(branchIndex * LEVELS_PER_BRANCH + index + 1)}
                  >
                    <path
                      d="M0 0 C-3 -22 16 -37 44 -34 C45 -10 27 3 0 0Z"
                      fill={(branchIndex + index) % 2 ? '#547c62' : '#87a886'}
                    />
                    <path
                      d="M4 -4 Q20 -19 34 -26"
                      stroke={(branchIndex + index) % 2 ? '#87a886' : '#b6caaa'}
                      strokeWidth="1.3"
                      opacity=".65"
                      fill="none"
                    />
                  </g>
                </g>
              ))}
            </g>
          ))}
          {/* Blossoms sit over the foliage even as later branches fill the crown. */}
          {branches.map((branch, branchIndex) => (
            <g key={branchIndex} transform={`translate(${branch.x} ${branch.y})`}>
              {flowerPositions
                .slice(0, Math.ceil(branch.petals / PETALS_PER_FLOWER))
                .map(({ x, y }, flower) => {
                  const count = Math.min(
                    PETALS_PER_FLOWER,
                    branch.petals - flower * PETALS_PER_FLOWER,
                  );
                  return (
                    <g key={flower} transform={`translate(${x} ${y})`}>
                      {Array.from({ length: count }, (_, petal) => (
                        <g
                          key={petal}
                          transform={`rotate(${petal * 60 + (branchIndex % 2 ? 15 : 0)})`}
                        >
                          <g
                            className="plant-petal"
                            style={growthStyle(
                              branchIndex * LEVELS_PER_BRANCH +
                                LEAVES_PER_BRANCH +
                                flower * PETALS_PER_FLOWER +
                                petal +
                                1,
                            )}
                          >
                            <ellipse
                              cx="0"
                              cy="-12"
                              rx="8"
                              ry="13"
                              fill={(branchIndex + flower) % 2 ? '#efc6b0' : '#d7b4cf'}
                            />
                          </g>
                        </g>
                      ))}
                      <circle className="plant-flower-center" cx="0" cy="0" r="7" fill="#d6b665" />
                      <circle cx="-2" cy="-2" r="2" fill="#f5e2a5" />
                    </g>
                  );
                })}
            </g>
          ))}
        </g>
        <path d="m85 128 9 45c2 11 61 11 64 0l9-45Z" fill="#e8b9a1" />
        <rect x="79" y="116" width="93" height="20" rx="8" fill="#efc6b0" />
        <circle cx="112" cy="147" r="3" fill="#6b5146" />
        <circle cx="143" cy="147" r="3" fill="#6b5146" />
        <path
          d="M121 155q7 7 13 0"
          stroke="#6b5146"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="105" cy="155" r="5" fill="#dda18e" opacity=".7" />
        <circle cx="151" cy="155" r="5" fill="#dda18e" opacity=".7" />
      </g>
      <g fill="#c4a863">
        <path d="m48 85 3-8 3 8 8 3-8 3-3 8-3-8-8-3Z" />
        <path d="m190 111 2-6 2 6 6 2-6 2-2 6-2-6-6-2Z" />
      </g>
      <g className="floating-check">
        <rect x="178" y="48" width="37" height="37" rx="12" fill="#fff" />
        <path
          d="m189 66 5 5 11-13"
          stroke="#527866"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
