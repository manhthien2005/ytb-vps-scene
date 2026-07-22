import type { SVGProps } from "react";

export type DriveIconProps = Readonly<{
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
}>;

const STROKE_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
} satisfies SVGProps<SVGSVGElement>;

function svgProps({ size = 20, className, "aria-hidden": ariaHidden }: DriveIconProps) {
  return {
    ...STROKE_PROPS,
    "aria-hidden": ariaHidden,
    className,
    height: size,
    viewBox: "0 0 24 24",
    width: size,
  } as const;
}

export function DriveLogo({ size = 22, className, "aria-hidden": ariaHidden }: DriveIconProps) {
  return (
    <svg aria-hidden={ariaHidden} className={className} height={size} viewBox="0 0 24 24" width={size}>
      <path d="M8.1 3h7.8l3.9 6.75H12z" fill="#ffd04a" />
      <path d="M8.1 3 2.2 13.2l3.9 6.75L12 9.75z" fill="#35a853" />
      <path d="M6.1 19.95h11.8l3.9-6.75-2-3.45H12z" fill="#4285f4" />
    </svg>
  );
}

export function FolderIcon(props: DriveIconProps) {
  return (
    <svg {...svgProps(props)} data-testid="folder-icon">
      <path d="M3.5 7.5h6l2-2h3.2a2 2 0 0 1 2 2v1H3.5z" />
      <path d="M3.5 8.5h17l-1.4 9.1a2 2 0 0 1-2 1.7H5.5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function FileVideoIcon(props: DriveIconProps) {
  return (
    <svg {...svgProps(props)} data-testid="video-icon">
      <path d="M6 2.8h7l5 5V21H6a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2Z" />
      <path d="M13 2.8v5h5" />
      <path d="m9.3 12.1 4.7 2.7-4.7 2.7z" />
    </svg>
  );
}

export function ChevronIcon({ direction = "right", ...props }: DriveIconProps & Readonly<{ direction?: "right" | "down" }>) {
  return (
    <svg {...svgProps(props)}>
      {direction === "down" ? <path d="m7 9 5 5 5-5" /> : <path d="m9 7 5 5-5 5" />}
    </svg>
  );
}

export function UploadIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 14v5h14v-5" /></svg>;
}

export function PauseIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="M9 7v10M15 7v10" /></svg>;
}

export function PlayIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="m9 6 9 6-9 6z" /></svg>;
}

export function DownloadIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5" /><path d="M5 20h14" /></svg>;
}

export function TrashIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="M4.5 7h15M9 3.5h6M7 7l.8 13h8.4L17 7M10 10v6M14 10v6" /></svg>;
}

export function ClockIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
}

export function TimerIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><circle cx="12" cy="13" r="7.5" /><path d="M9.5 3h5M12 5.5V8m5.3-.3 1.4-1.4" /></svg>;
}

export function DimensionsIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><rect height="13" rx="1.5" width="17" x="3.5" y="5.5" /><path d="m7 9-1.5 1.5L7 12m10-3 1.5 1.5L17 12M9 15h6" /></svg>;
}

export function ExternalLinkIcon(props: DriveIconProps) {
  return <svg {...svgProps(props)}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg>;
}
