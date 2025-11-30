// @ts-nocheck
import React, { Component, ReactNode } from 'react';

type TurnServiceErrorBoundaryProps = {
  children?: ReactNode;
};

type TurnServiceErrorBoundaryState = {
  hasError: boolean;
};

class TurnServiceErrorBoundary extends Component<
  TurnServiceErrorBoundaryProps,
  TurnServiceErrorBoundaryState
> {
  constructor(props: TurnServiceErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: unknown) {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('Error caught in TurnServiceErrorBoundary:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return <h1>Something went wrong with the turn service.</h1>;
    }
    return this.props.children;
  }
}

export default TurnServiceErrorBoundary;
