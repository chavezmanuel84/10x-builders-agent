import type {
  ComponentPropsWithoutRef,
  ElementType,
  ReactNode,
  SVGProps,
} from "react";

type IconComponent = ElementType<SVGProps<SVGSVGElement>>;
type NavActionVariant = "default" | "ghost";

type SharedProps = {
  children: ReactNode;
  icon?: IconComponent;
  variant?: NavActionVariant;
  className?: string;
};

type AnchorProps = SharedProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof SharedProps> & {
    as: "a";
  };

type ButtonProps = SharedProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof SharedProps> & {
    as?: "button";
  };

type NavActionButtonProps = AnchorProps | ButtonProps;

const BASE_CLASS =
  "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors";

const VARIANT_CLASS: Record<NavActionVariant, string> = {
  default:
    "border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900",
  ghost:
    "border border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-900/70",
};

function joinClasses(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function NavActionButton(props: NavActionButtonProps) {
  const { icon: Icon, variant = "default", className, children } = props;
  const classes = joinClasses(BASE_CLASS, VARIANT_CLASS[variant], className);
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
      <span>{children}</span>
    </>
  );

  if (props.as === "a") {
    const anchorProps = { ...props } as ComponentPropsWithoutRef<"a"> & {
      as?: "a";
      icon?: IconComponent;
      variant?: NavActionVariant;
    };
    delete anchorProps.as;
    delete anchorProps.icon;
    delete anchorProps.variant;
    delete anchorProps.className;
    delete anchorProps.children;
    return (
      <a {...anchorProps} className={classes}>
        {content}
      </a>
    );
  }

  const buttonProps = { ...props } as ComponentPropsWithoutRef<"button"> & {
    as?: "button";
    icon?: IconComponent;
    variant?: NavActionVariant;
  };
  delete buttonProps.as;
  delete buttonProps.icon;
  delete buttonProps.variant;
  delete buttonProps.className;
  delete buttonProps.children;
  const { type = "button" } = buttonProps;
  return (
    <button {...buttonProps} type={type} className={classes}>
      {content}
    </button>
  );
}
