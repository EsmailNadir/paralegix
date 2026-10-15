'use client';

import { useRef, useLayoutEffect } from 'react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  fullPage?: boolean;
}

export default function LoadingSpinner({ size = 'md', className = '', fullPage = false }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-5 h-5',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  const svgRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    if (svgRef.current) {
      const el = svgRef.current;
      // Restart animation synced to page load time so all spinners
      // appear at the same phase, no visible "reset" across navigations
      el.style.animation = 'none';
      el.getBoundingClientRect();
      el.style.removeProperty('animation');
      el.style.animationDelay = `-${Math.round(performance.now())}ms`;
    }
  }, []);

  const spinner = (
    <div className={`inline-block ${className}`} role="status" aria-label="Loading">
      <svg
        ref={svgRef}
        className={`animate-spin ${sizeClasses[size]}`}
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="var(--accent-solid)"
          strokeOpacity="0.15"
          strokeWidth="3"
        />
        <path
          d="M22 12a10 10 0 01-10 10"
          stroke="url(#spinnerGrad)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="spinnerGrad" x1="22" y1="12" x2="12" y2="22">
            <stop stopColor="var(--accent-solid)" />
            <stop offset="1" stopColor="var(--accent-gradient-end)" />
          </linearGradient>
        </defs>
      </svg>
      <span className="sr-only">Loading...</span>
    </div>
  );

  if (fullPage) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        {spinner}
      </div>
    );
  }

  return spinner;
}
