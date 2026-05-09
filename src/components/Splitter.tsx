import { useEffect, useCallback, useRef, useState, ReactNode } from "react";
import { Box } from "@mui/material";

interface SplitterProps {
  direction: "horizontal" | "vertical";
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  children: [ReactNode, ReactNode];
  onSizeChange?: (size: number) => void;
}

export function Splitter({
  direction,
  initialSize = 300,
  minSize = 100,
  maxSize = Infinity,
  children,
  onSizeChange,
}: SplitterProps) {
  const [size, setSize] = useState(initialSize);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartPosRef = useRef<number>(0);
  const dragStartSizeRef = useRef<number>(0);

  const isVertical = direction === "vertical";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartPosRef.current = isVertical ? e.clientX : e.clientY;
      dragStartSizeRef.current = size;
    },
    [isVertical, size]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;
      const currentPos = isVertical ? e.clientX : e.clientY;
      const delta = currentPos - dragStartPosRef.current;
      const newSize = dragStartSizeRef.current + delta;
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerSize = isVertical
        ? containerRect.width
        : containerRect.height;
      const effectiveMaxSize = Math.min(maxSize, containerSize - minSize - 4);
      const clampedSize = Math.max(
        minSize,
        Math.min(effectiveMaxSize, newSize)
      );
      setSize(clampedSize);
      onSizeChange?.(clampedSize);
    },
    [isDragging, isVertical, minSize, maxSize, onSizeChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "none";
      document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, isVertical]);

  return (
    <Box
      ref={containerRef}
      sx={{
        display: "flex",
        flexDirection: isVertical ? "row" : "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          [isVertical ? "width" : "height"]: `${size}px`,
          [isVertical ? "minWidth" : "minHeight"]: `${size}px`,
          [isVertical ? "maxWidth" : "maxHeight"]: `${size}px`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children[0]}
      </Box>
      <Box
        onMouseDown={handleMouseDown}
        sx={{
          [isVertical ? "width" : "height"]: "3px",
          [isVertical ? "minWidth" : "minHeight"]: "3px",
          cursor: isVertical ? "col-resize" : "row-resize",
          bgcolor: "rgba(128,128,128,0.15)",
          "&:hover": { bgcolor: "primary.main", opacity: 0.7 },
          transition: "background-color 0.15s, opacity 0.15s",
          zIndex: 1,
        }}
      />
      <Box
        sx={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children[1]}
      </Box>
    </Box>
  );
}
