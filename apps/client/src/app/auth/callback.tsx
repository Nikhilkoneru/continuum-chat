import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

export default function AuthCallbackScreen() {
  return (
    <View style={styles.container}>
      <ActivityIndicator color="#60a5fa" />
      <Text style={styles.text}>Finishing GitHub sign-in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#0b1020',
  },
  text: {
    color: '#f8fafc',
    fontSize: 16,
  },
});
