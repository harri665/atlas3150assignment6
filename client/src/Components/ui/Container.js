import React from 'react';

// padding matches the nav's so content lines up under the wordmark
export default function Container({ as: As = 'div', className = '', children, ...props }) {
  return (
    <div className="px-3 sm:px-6">
      <As className={`mx-auto w-full max-w-7xl px-5 sm:px-6 ${className}`} {...props}>
        {children}
      </As>
    </div>
  );
}
