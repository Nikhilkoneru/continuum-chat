import { StyleSheet, Text, View } from 'react-native';

export function StatusCard({
  title,
  value,
  tone = 'neutral',
}: {
  title: string;
  value: string;
  tone?: 'neutral' | 'success' | 'warning';
}) {
  return (
    <View style={[styles.card, tone === 'success' ? styles.success : tone === 'warning' ? styles.warning : undefined]}>
      <Text style={styles.label}>{title}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#141b34',
    borderWidth: 1,
    borderColor: '#263154',
    gap: 4,
    minWidth: 140,
  },
  success: {
    borderColor: '#2f855a',
  },
  warning: {
    borderColor: '#d69e2e',
  },
  label: {
    color: '#8ea0d0',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  value: {
    color: '#f7fafc',
    fontSize: 14,
    fontWeight: '600',
  },
});
