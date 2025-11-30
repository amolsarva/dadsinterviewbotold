import React, { Component } from 'react';

class TurnServiceErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error) {
        // Update state so the next render shows the fallback UI
        return { hasError: true }; 
    }

    componentDidCatch(error, info) {
        // You can also log the error to an error reporting service
        console.error('Error caught in TurnServiceErrorBoundary:', error, info);
    }

    render() {
        if (this.state.hasError) {
            // You can render any custom fallback UI
            return <h1>Something went wrong with the turn service.</h1>;
        }

        return this.props.children; 
    }
}

export default TurnServiceErrorBoundary;
