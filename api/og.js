import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const h = (type, props, ...children) => ({
  type,
  key: null,
  ref: null,
  props: { ...props, children: children.length === 1 ? children[0] : children },
});

export default function handler() {
  return new ImageResponse(
    h(
      'div',
      {
        style: {
          width: '100%',
          height: '100%',
          background: '#000',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          position: 'relative',
        },
      },
      h('div', {
        style: {
          position: 'absolute',
          top: '-200px',
          right: '-200px',
          width: '700px',
          height: '700px',
          background: 'radial-gradient(circle, rgba(236,72,153,0.30) 0%, rgba(236,72,153,0) 70%)',
          filter: 'blur(40px)',
          display: 'flex',
        },
      }),
      h('div', {
        style: {
          position: 'absolute',
          bottom: '-150px',
          left: '-150px',
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, rgba(255,212,59,0.18) 0%, rgba(255,212,59,0) 70%)',
          filter: 'blur(40px)',
          display: 'flex',
        },
      }),
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            color: '#888',
            fontSize: '20px',
            letterSpacing: '4px',
            textTransform: 'uppercase',
            fontWeight: 600,
            zIndex: 1,
          },
        },
        h('div', {
          style: {
            width: '12px',
            height: '12px',
            background: '#EC4899',
            borderRadius: '50%',
            display: 'flex',
          },
        }),
        h('div', { style: { display: 'flex' } }, 'Polymarket Whale Tracker'),
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '24px',
            zIndex: 1,
          },
        },
        h(
          'div',
          {
            style: {
              fontSize: '180px',
              fontWeight: 900,
              letterSpacing: '-6px',
              lineHeight: 0.9,
              backgroundImage:
                'linear-gradient(90deg,#FF3D8C 0%,#FF6FA0 22%,#FF9C7A 50%,#FFB85E 75%,#FFD43B 100%)',
              backgroundClip: 'text',
              color: 'transparent',
              display: 'flex',
            },
          },
          'POLYBABY',
        ),
        h(
          'div',
          {
            style: {
              fontSize: '36px',
              color: '#fff',
              fontWeight: 700,
              letterSpacing: '-1px',
              display: 'flex',
            },
          },
          'Track who’s already betting.',
        ),
        h(
          'div',
          {
            style: {
              fontSize: '20px',
              color: '#888',
              letterSpacing: '2px',
              textTransform: 'uppercase',
              fontWeight: 600,
              display: 'flex',
              gap: '24px',
            },
          },
          h('div', { style: { display: 'flex' } }, 'Real-time alerts'),
          h('div', { style: { display: 'flex', color: '#444' } }, '·'),
          h('div', { style: { display: 'flex' } }, 'Smart-money divergence'),
          h('div', { style: { display: 'flex', color: '#444' } }, '·'),
          h('div', { style: { display: 'flex' } }, '63.7% verifiable'),
        ),
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            color: '#666',
            fontSize: '20px',
            letterSpacing: '3px',
            textTransform: 'uppercase',
            fontWeight: 600,
            zIndex: 1,
          },
        },
        h('div', { style: { display: 'flex' } }, 'polybabyalerts.com'),
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: '14px',
              padding: '14px 28px',
              background: '#EC4899',
              color: '#000',
              borderRadius: '999px',
              fontWeight: 800,
              letterSpacing: '1.5px',
              fontSize: '20px',
            },
          },
          'Join Discord →',
        ),
      ),
    ),
    { width: 1200, height: 630 },
  );
}
