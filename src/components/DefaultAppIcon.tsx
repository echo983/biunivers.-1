interface DefaultAppIconProps {
  label: string;
}

export function DefaultAppIcon({ label }: DefaultAppIconProps) {
  return (
    <span className="default-app-icon" aria-hidden="true">
      {label.trim().charAt(0).toLocaleUpperCase() || "·"}
    </span>
  );
}
