import { memo, useEffect, useRef } from "react";
import { updateSvg } from "jdenticon/browser";

const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
const IDENTICON_CONFIG = { padding: 0.08 } as const;

interface EntryIdenticonProps {
  entryId: string;
  size: number;
  className?: string;
}

export const EntryIdenticon = memo(function EntryIdenticon({
  entryId,
  size,
  className,
}: EntryIdenticonProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const valid = ENTRY_ID_PATTERN.test(entryId);

  useEffect(() => {
    if (valid && svgRef.current) {
      updateSvg(svgRef.current, entryId, IDENTICON_CONFIG);
    }
  }, [entryId, valid]);

  if (!valid) {
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        📄
      </span>
    );
  }

  return (
    <svg
      ref={svgRef}
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    />
  );
});
