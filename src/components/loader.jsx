import React from 'react'

const Loader = ({ size = 'medium', fullScreen = false, text = 'Loading...', variant = 'orbit', hardcodeVariant = null }) => {
  const sizeMap = {
    small: { spinner: 40, circle: 3, pulse: 10 },
    medium: { spinner: 60, circle: 3, pulse: 16 },
    large: { spinner: 80, circle: 4, pulse: 20 },
  }

  const dims = sizeMap[size]
  const activeVariant = hardcodeVariant || variant

  const loaderStyles = {
    container: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      ...(fullScreen ? {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(245, 245, 245, 0.98) 100%)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
      } : {
        padding: '3rem',
        minHeight: '200px',
      }),
    },
    spinner: {
      position: 'relative',
      width: `${dims.spinner}px`,
      height: `${dims.spinner}px`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    loaderContent: {
      position: 'relative',
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    
    // Classic variant
    circle: {
      position: 'absolute',
      width: '100%',
      height: '100%',
      border: `${dims.circle}px solid rgba(0, 0, 0, 0.08)`,
      borderTop: `${dims.circle}px solid #000000`,
      borderRight: `${dims.circle}px solid #00000040`,
      borderRadius: '50%',
      animation: 'spin 1s linear infinite',
      boxShadow: '0 0 20px rgba(0, 0, 0, 0.05)',
    },
    pulse: {
      position: 'absolute',
      width: `${dims.pulse}px`,
      height: `${dims.pulse}px`,
      background: 'radial-gradient(circle, #000000 0%, #00000060 70%)',
      borderRadius: '50%',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      opacity: 0,
      animation: 'pulse-animation 1.5s ease-in-out infinite',
      boxShadow: '0 0 15px rgba(0, 0, 0, 0.1)',
    },

    text: {
      marginTop: size === 'small' ? '1rem' : size === 'large' ? '2rem' : '1.5rem',
      fontSize: size === 'small' ? '0.85rem' : size === 'large' ? '1.1rem' : '0.95rem',
      color: '#333',
      fontWeight: 600,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      background: 'linear-gradient(135deg, #000 0%, #666 100%)',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      animation: 'fade-in 0.6s ease-in-out',
    },
    dots: {
      display: 'inline-block',
      marginLeft: '0.3rem',
      animation: 'dots-animation 1.5s steps(4, end) infinite',
    },
  }

  const keyframes = `
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes pulse-animation {
      0% {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
        box-shadow: 0 0 15px rgba(0, 0, 0, 0.3);
      }
      50% {
        opacity: 0.5;
      }
      100% {
        opacity: 0;
        transform: translate(-50%, -50%) scale(1.8);
        box-shadow: 0 0 0px rgba(0, 0, 0, 0);
      }
    }
    @keyframes dots-animation {
      0%, 20% { content: ''; }
      40% { content: '.'; }
      60% { content: '..'; }
      80%, 100% { content: '...'; }
    }
    @keyframes fade-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    @keyframes orbit {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
    }
  `

  const renderLoader = () => {
    switch (activeVariant) {
      case 'orbit':
        return (
          <div style={loaderStyles.loaderContent}>
            <div style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              border: `${dims.circle}px dashed rgba(0,0,0,0.1)`,
              borderRadius: '50%',
            }}></div>
            <div style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              animation: 'orbit 3s linear infinite',
            }}>
              <div style={{
                position: 'absolute',
                width: `${dims.pulse}px`,
                height: `${dims.pulse}px`,
                background: '#000000',
                borderRadius: '50%',
                top: 0,
                left: '50%',
                transform: 'translateX(-50%)',
                boxShadow: '0 0 10px rgba(0,0,0,0.3)',
              }}></div>
            </div>
          </div>
        )
      case 'classic':
      default:
        return (
          <div style={loaderStyles.loaderContent}>
            <div style={loaderStyles.circle}></div>
            <div style={loaderStyles.pulse}></div>
          </div>
        )
    }
  }

  return (
    <>
      <style>{keyframes}</style>
      <div style={loaderStyles.container}>
        <div style={loaderStyles.spinner}>
          {renderLoader()}
        </div>
        {text && (
          <div style={loaderStyles.text}>
            {text}
            <span style={loaderStyles.dots}></span>
          </div>
        )}
      </div>
    </>
  )
}

// Demo component to show different variants
const LoaderDemo = () => {
  return (
    <div style={{ padding: '2rem', background: '#f5f5f5', minHeight: '100vh' }}>
      <h2 style={{ textAlign: 'center', marginBottom: '3rem', color: '#333' }}>Loader Component Demo</h2>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem', marginBottom: '3rem' }}>
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Orbit - Small</h3>
          <Loader size="small" variant="orbit" text="Loading" />
        </div>
        
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Orbit - Medium</h3>
          <Loader size="medium" variant="orbit" text="Processing" />
        </div>
        
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Orbit - Large</h3>
          <Loader size="large" variant="orbit" text="Please wait" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Classic - Small</h3>
          <Loader size="small" variant="classic" text="Loading" />
        </div>
        
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Classic - Medium</h3>
          <Loader size="medium" variant="classic" text="Processing" />
        </div>
        
        <div style={{ background: 'white', borderRadius: '12px', padding: '2rem', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ textAlign: 'center', marginBottom: '1rem' }}>Classic - Large</h3>
          <Loader size="large" variant="classic" text="Please wait" />
        </div>
      </div>
    </div>
  )
}

export default Loader