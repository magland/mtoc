% Conjugate transpose `'`. Differs from `.'` only on complex inputs:
% the real lane is reordered identically; the imag lane is also
% negated. Scalars: real / char are identity; complex scalars
% conjugate. Cross-runs byte-for-byte against numbl.

% Scalar real
disp(5');
disp((-3.5)');

% Scalar complex
z = 3 + 4i;
disp(z');

% Real matrix — `'` and `.'` agree.
B = [1 2 3; 4 5 6];
disp(B');
disp(B.');
disp(B' - B.');

% Complex matrix — `'` conjugates, `.'` doesn't.
A = [1+2i 3+4i; 5-6i 7];
disp(A');
disp(A.');

% Row / column vectors
r = [1+1i 2 3-4i];
disp(r');
c = [1; 2-3i; 4+5i];
disp(c');

% Composition
disp(B'');
disp(A'');
