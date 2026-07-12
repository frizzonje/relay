import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // база: компактная, плавный hover/press, фокус-кольцо в приглушённом акценте
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold ' +
    'transition-[background,transform,box-shadow,color] duration-150 select-none ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong ' +
    'disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] ' +
    '[&_.ico]:text-[1.15em]',
  {
    variants: {
      variant: {
        // главный акцент — монохром (как «Присоединиться»/«Войти»), без цветных заливок
        primary: 'bg-accent-strong text-bg-app hover:brightness-95 shadow-none',
        // призрачный — второстепенное действие (отмена)
        ghost: 'text-text-muted hover:bg-bg-hover hover:text-text',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
