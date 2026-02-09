import React, {useEffect, useState} from 'react';
import {View, Text, ActivityIndicator, StyleSheet} from 'react-native';
import QRCodeLib from 'qrcode';

interface LinkingScreenProps {
  qrUrl: string | null;
  error: string | null;
  isLinking: boolean;
}

// Render QR code as native View components
function QRCodeView({value, size}: {value: string; size: number}) {
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    QRCodeLib.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
    })
      .then(() => {
        const qr = QRCodeLib.create(value, {errorCorrectionLevel: 'M'});
        const modules = qr.modules;
        const data = modules.data;
        const qrSize = modules.size;

        const grid: boolean[][] = [];
        for (let row = 0; row < qrSize; row++) {
          const rowData: boolean[] = [];
          for (let col = 0; col < qrSize; col++) {
            rowData.push(data[row * qrSize + col] === 1);
          }
          grid.push(rowData);
        }
        setMatrix(grid);
        setError(null);
      })
      .catch(err => {
        try {
          const qr = QRCodeLib.create(value, {errorCorrectionLevel: 'M'});
          const modules = qr.modules;
          const data = modules.data;
          const qrSize = modules.size;

          const grid: boolean[][] = [];
          for (let row = 0; row < qrSize; row++) {
            const rowData: boolean[] = [];
            for (let col = 0; col < qrSize; col++) {
              rowData.push(data[row * qrSize + col] === 1);
            }
            grid.push(rowData);
          }
          setMatrix(grid);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to generate QR');
        }
      });
  }, [value]);

  if (error) {
    return <Text style={{color: 'red'}}>{error}</Text>;
  }

  if (!matrix) {
    return <ActivityIndicator size="small" color="#2196f3" />;
  }

  const cellSize = Math.floor(size / matrix.length);
  const actualSize = cellSize * matrix.length;

  return (
    <View style={{
      width: actualSize,
      height: actualSize,
      backgroundColor: '#ffffff',
      flexDirection: 'column',
    }}>
      {matrix.map((row, rowIndex) => (
        <View key={rowIndex} style={{flexDirection: 'row'}}>
          {row.map((cell, colIndex) => (
            <View
              key={colIndex}
              style={{
                width: cellSize,
                height: cellSize,
                backgroundColor: cell ? '#000000' : '#ffffff',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export function LinkingScreen({qrUrl, error, isLinking}: LinkingScreenProps) {
  useEffect(() => {
    console.warn('LinkingScreen props - qrUrl:', qrUrl ? `(${qrUrl.length} chars)` : 'null', 'error:', error, 'isLinking:', isLinking);
  }, [qrUrl, error, isLinking]);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Link to Signal</Text>
        <Text style={styles.subtitle}>
          Scan this QR code with your Signal app to link this device
        </Text>

        <View style={styles.qrContainer}>
          {error ? (
            <View style={styles.error}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : qrUrl ? (
            <QRCodeView value={qrUrl} size={200} />
          ) : isLinking ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#2196f3" />
              <Text style={styles.loadingText}>Generating QR code...</Text>
            </View>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#2196f3" />
              <Text style={styles.loadingText}>Initializing...</Text>
            </View>
          )}
        </View>

        {qrUrl && isLinking && (
          <View style={styles.waitingContainer}>
            <ActivityIndicator size="small" color="#2196f3" />
            <Text style={styles.waitingText}>
              Waiting for you to scan the code...
            </Text>
          </View>
        )}

        <Text style={styles.instruction}>
          Open Signal on your phone, go to Settings → Linked Devices → Link
          New Device
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
    padding: 20,
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 32,
    maxWidth: 400,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#212121',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#757575',
    textAlign: 'center',
    marginBottom: 24,
  },
  qrContainer: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'white',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  loading: {
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
    color: '#757575',
  },
  error: {
    padding: 16,
  },
  errorText: {
    color: '#f44336',
    textAlign: 'center',
  },
  waitingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
  },
  waitingText: {
    marginLeft: 8,
    fontSize: 14,
    color: '#757575',
  },
  instruction: {
    fontSize: 12,
    color: '#9e9e9e',
    textAlign: 'center',
    marginTop: 20,
  },
});
