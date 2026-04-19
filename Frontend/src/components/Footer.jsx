import React, { useState } from 'react';
import logo from '../assets/TG-Black.png'

const styles = {
	footer: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '0.5rem 2rem',
		borderTop: '1px solid rgba(0,0,0,0.08)',
		background: 'linear-gradient(135deg, #ffffff 0%, #fafbfc 100%)',
		boxShadow: '0 -2px 8px rgba(0,0,0,0.04)',
		marginTop: 'auto',
		transition: 'all 0.3s ease',
	},
	leftSection: {
		display: 'flex',
		alignItems: 'center',
		gap: '1.5rem',
	},
	companyInfo: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0.25rem',
		lineHeight: 1.2,
	},
	companyName: {
		fontSize: '0.9rem',
		fontWeight: 700,
		color: '#000',
		letterSpacing: '0.03em',
	},
	copyright: {
		fontSize: '0.75rem',
		color: '#888',
		fontWeight: 500,
	},
	rightSection: {
		display: 'flex',
		alignItems: 'center',
		gap: '1rem',
	},
	logoContainer: {
		height: '50px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		cursor: 'pointer',
		transition: 'all 0.3s ease',
		padding: '0.5rem',
		borderRadius: '8px',
	},
	logo: {
		height: '40px',
		opacity: 0.7,
		transition: 'all 0.3s ease',
		filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.06))',
	},
}

const Footer = () => {
	const currentYear = new Date().getFullYear();
	const [logoHover, setLogoHover] = useState(false);

	return (
		<footer style={styles.footer}>
			{/* Left Section - Company Info */}
			<div style={styles.leftSection}>
				<div style={styles.companyInfo}>
					<span style={styles.companyName}>Technology Garage</span>
					<span style={styles.copyright}>© {currentYear} All rights reserved</span>
				</div>
			</div>

			{/* Right Section - Logo */}
			<div style={styles.rightSection}>
				<div
					style={{
						...styles.logoContainer,
						...(logoHover ? {
							background: 'rgba(0,0,0,0.04)',
							transform: 'translateY(-2px)',
							boxShadow: '0 4px 8px rgba(0,0,0,0.08)',
						} : {})
					}}
					onMouseEnter={() => setLogoHover(true)}
					onMouseLeave={() => setLogoHover(false)}
				>
					<img
						src={logo}
						alt="Footer Logo"
						style={{
							...styles.logo,
							opacity: logoHover ? 1 : 0.7,
							transform: logoHover ? 'scale(1.05)' : 'scale(1)',
						}}
					/>
				</div>
			</div>
		</footer>
	);
};

export default Footer;
