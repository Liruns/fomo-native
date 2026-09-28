import type { SVGProps } from "react";

/** Compact vector wordmark shared by navigation, onboarding, and assistant attribution. */
export function OmOWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 144 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <text x="0" y="21" fontSize="23" fontWeight="600" fontFamily="system-ui, sans-serif">
        fomo-native
      </text>
    </svg>
  );
}
