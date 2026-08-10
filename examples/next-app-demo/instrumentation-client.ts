if (process.env.NODE_ENV === 'development') {
  void import('@patchlens-ai/dev/runtime').then(({ installPatchLensInspector }) => {
    void installPatchLensInspector({ manifestEndpoint: false });
  });
}
