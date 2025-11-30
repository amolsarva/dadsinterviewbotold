import React, { useEffect, useState } from 'react';

const SupabaseHealthPanel = () => {
    const [healthStatus, setHealthStatus] = useState('');

    useEffect(() => {
        const checkHealth = async () => {
            try {
                const response = await fetch('https://YOUR_SUPABASE_URL/rest/v1/status');
                const data = await response.json();
                setHealthStatus(data.status);
            } catch (error) {
                setHealthStatus('Error fetching health status');
            }
        };

        checkHealth();
    }, []);

    return (
        <div>
            <h1>Supabase Health Status</h1>
            <p>Status: {healthStatus || 'Loading...'}</p>
        </div>
    );
};

export default SupabaseHealthPanel;