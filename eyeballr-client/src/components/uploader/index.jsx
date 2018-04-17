import React from 'react';
import Dropzone from 'react-dropzon';

const onDrop = (acceptedFiles, rejectedFiles) => {
  // TODO: Do something with the files
};

export default class Uploader extends React.Component {
  onDrop;
  render() {
    return <div className="dropzone">
      <Dropzone onDrop={this.onDrop.bind(this)}>
        <p>Drop a selfie here.</p>
      </Dropzone>
    </div>
  };
};
